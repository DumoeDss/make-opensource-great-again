import type { ReplaySourceWireProtocol } from '../types.js';

/**
 * Synthesize a valid single-event SSE stream from a non-streaming converted
 * response body in the CLI's source wire protocol. The proxy always sends
 * `stream:false` upstream (the response is throwaway); if the CLI requested
 * streaming, this adapter wraps the converted body in the protocol's event
 * envelope so the CLI's SSE parser can read the completion and exit.
 *
 * The synthesized stream is NOT a mutation of inference content — the semantic
 * response is preserved; only the transport framing adapts.
 */
export function synthesizeStream(
  sourceProtocol: ReplaySourceWireProtocol,
  convertedResponseBody: Uint8Array,
): Uint8Array {
  if (sourceProtocol === 'anthropic-messages') {
    return synthesizeAnthropicStream(convertedResponseBody);
  }
  return synthesizeResponsesStream(convertedResponseBody);
}

/**
 * Synthesize an Anthropic Messages SSE stream:
 * `message_start` -> `content_block_start` -> `content_block_delta` ->
 * `content_block_stop` -> `message_delta` -> `message_stop`.
 *
 * The full completion text is carried in a single `content_block_delta` so the
 * event sequence is parseable by any conformant Anthropic SSE consumer.
 */
function synthesizeAnthropicStream(convertedResponseBody: Uint8Array): Uint8Array {
  const parsed = safeJson(convertedResponseBody) as Record<string, unknown> | null;
  const text = extractAnthropicText(parsed);
  const stopReason =
    parsed && typeof parsed.stop_reason === 'string' ? parsed.stop_reason : 'end_turn';
  const model =
    parsed && typeof parsed.model === 'string' ? parsed.model : 'claude-3-sonnet-20240229';
  const messageId =
    parsed && typeof parsed.id === 'string' ? parsed.id : `msg_${Math.random().toString(36).slice(2)}`;
  const usage =
    parsed && isObject(parsed.usage)
      ? parsed.usage
      : { input_tokens: 0, output_tokens: 0 };

  const events: string[] = [];
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
  );
  events.push(
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );
  events.push(
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
  );
  events.push(
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  );
  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: countOutputTokens(parsed) },
    }),
  );
  events.push(sseEvent('message_stop', { type: 'message_stop' }));
  return Buffer.from(events.join(''), 'utf8');
}

/**
 * Synthesize an OpenAI Responses SSE stream: `response.created` ->
 * `response.output_item.added` -> `response.completed`. The full output is
 * carried in the completed event so any conformant Responses SSE consumer can
 * read it.
 */
function synthesizeResponsesStream(convertedResponseBody: Uint8Array): Uint8Array {
  const parsed = safeJson(convertedResponseBody) as Record<string, unknown> | null;
  const responseId =
    parsed && typeof parsed.id === 'string'
      ? parsed.id
      : `resp_${Math.random().toString(36).slice(2)}`;
  const model =
    parsed && typeof parsed.model === 'string' ? parsed.model : 'gpt-4o';
  const output = parsed && Array.isArray(parsed.output) ? parsed.output : [];
  const usage =
    parsed && isObject(parsed.usage)
      ? parsed.usage
      : { input_tokens: 0, output_tokens: 0 };

  const responseObject = {
    id: responseId,
    object: 'response',
    status: 'completed',
    model,
    output,
    usage,
  };

  const events: string[] = [];
  events.push(
    sseEvent('response.created', {
      type: 'response.created',
      response: { ...responseObject, status: 'in_progress' },
    }),
  );
  events.push(
    sseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: Array.isArray(output) && output.length > 0 ? output[0] : null,
    }),
  );
  events.push(
    sseEvent('response.completed', {
      type: 'response.completed',
      response: responseObject,
    }),
  );
  return Buffer.from(events.join(''), 'utf8');
}

function extractAnthropicText(parsed: Record<string, unknown> | null): string {
  if (!parsed || !Array.isArray(parsed.content)) return '';
  return parsed.content
    .map((block) => {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      return '';
    })
    .join('');
}

function countOutputTokens(parsed: Record<string, unknown> | null): number {
  if (parsed && isObject(parsed.usage)) {
    const out = (parsed.usage as Record<string, unknown>).output_tokens;
    if (typeof out === 'number' && Number.isFinite(out) && out >= 0) {
      return Math.trunc(out);
    }
  }
  return 0;
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function safeJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
