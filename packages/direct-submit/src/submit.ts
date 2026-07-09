import type {
  ContributionConsent,
  SanitizedSession,
  SubmissionReceipt,
  SubmissionUsage,
} from '@mosga/contracts';
import type { CompiledRuleset } from '@mosga/sanitizer';
import {
  buildGeminiApiUrl,
  buildOpenAIResponseApiUrl,
  convertAnthropicRequestToOpenAI,
  convertMessageToGemini,
} from '@omnicross/core';
import type {
  AnthropicChatRequest,
  AnthropicContentPart,
  AnthropicMessage,
  OpenAIChatRequest,
  SimpleChatMessage,
} from '@omnicross/contracts/completion-types';

import { assertOutboundClean } from './backstop.js';
import { assertConsent } from './consent.js';
import { KeyNotConfiguredError } from './keys.js';
import type { ProviderTarget } from './providers.js';
import {
  buildAnthropicRequest,
  buildMetaMessage,
  foldThinkingIntoText,
  serializeMeta,
  toAnthropicMessages,
  type MetaVersions,
} from './reconstruct.js';
import type { OutboundRequest, Transport } from './transport.js';

/** Raised when submission is attempted on a session that is not gate-unlocked/stamped. */
export class NotStampedError extends Error {
  constructor() {
    super('session is not stamped (meta.sanitized !== true); refusing to submit an un-sanitized session');
    this.name = 'NotStampedError';
  }
}

export interface SubmitParams {
  session: SanitizedSession;
  target: ProviderTarget;
  model: string;
  consent: ContributionConsent;
  ruleset: CompiledRuleset;
  /** The contributor's key, already resolved server-side. Used only as the auth header. */
  apiKey: string | undefined;
  transport: Transport;
  versions: MetaVersions;
  /** Override the receipt timestamp for deterministic tests. */
  now?: string;
  /** Override the backstop scan timestamp for deterministic tests. */
  generatedAt?: string;
}

/**
 * Auth header for the chosen provider format — the ONLY place the key appears.
 * `openai` + `openai-response` use `Authorization: Bearer`; `anthropic` uses
 * `x-api-key`; `gemini` uses `x-goog-api-key`.
 */
function authHeaders(target: ProviderTarget, apiKey: string): Record<string, string> {
  switch (target.apiFormat) {
    case 'anthropic':
      return {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
    case 'gemini':
      return { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
    default:
      return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  }
}

/**
 * The exact outbound URL for the target. Anthropic + OpenAI presets carry a
 * full endpoint in `apiBaseUrl` and POST to it as-is (unchanged behavior);
 * `gemini` and `openai-response` (custom providers only) normalize the user's
 * base URL into the format-specific endpoint via the omnicross URL builders.
 */
function outboundUrl(target: ProviderTarget, model: string): string {
  switch (target.apiFormat) {
    case 'gemini':
      return buildGeminiApiUrl(target.apiBaseUrl, model, false);
    case 'openai-response':
      return buildOpenAIResponseApiUrl(target.apiBaseUrl);
    default:
      return target.apiBaseUrl;
  }
}

/**
 * Convert the reconstructed Anthropic request to an OpenAI chat-completions
 * request (folding thinking into text first — the converter drops thinking
 * blocks, which would strip reasoning and can yield a null-content assistant
 * turn OpenAI-compatible providers reject) and assert no assistant turn is empty
 * with no tool calls (an invalid OpenAI shape → a clear local error, never a
 * silent malformed send). Reused by both the `openai` and `openai-response`
 * serializers.
 */
function toOpenAIChatRequest(request: AnthropicChatRequest, model: string): OpenAIChatRequest {
  const openai = convertAnthropicRequestToOpenAI(foldThinkingIntoText(request));
  openai.model = model; // ensure the target model id, not the source's
  for (const m of openai.messages) {
    if (
      m.role === 'assistant' &&
      (m.content === null || m.content === '') &&
      !(m.tool_calls && m.tool_calls.length > 0)
    ) {
      throw new Error(
        'reconstruction produced an empty assistant message with no tool calls after OpenAI conversion',
      );
    }
  }
  return openai;
}

/** Flatten one Anthropic message's content parts into a single text string for
 *  the Gemini direct path (text-and-tool-structure only; non-text is absent
 *  upstream). Thinking is already folded into text before this runs. */
function flattenAnthropicContent(content: string | AnthropicContentPart[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'thinking') parts.push(`<thinking>\n${part.thinking}\n</thinking>`);
    else if (part.type === 'tool_use') {
      parts.push(`[tool_use: ${part.name} ${JSON.stringify(part.input)}]`);
    } else if (part.type === 'tool_result') {
      const body = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      parts.push(`[tool_result${part.is_error ? ' (error)' : ''}: ${body}]`);
    }
  }
  return parts.join('\n');
}

/**
 * Build a Gemini `generateContent` request body from the reconstructed Anthropic
 * request: `contents[]` assembled per message via `@omnicross/core`'s
 * `convertMessageToGemini` (roles map user→user, assistant→model), `system`
 * folded into `systemInstruction`, and `generationConfig.maxOutputTokens` from
 * the request budget. Thinking is folded into text first so it survives.
 */
function toGeminiRequest(request: AnthropicChatRequest, model: string): Record<string, unknown> {
  void model; // model rides in the URL, not the body, for Gemini
  const folded = foldThinkingIntoText(request);
  const contents = folded.messages.map((msg) => {
    const flat: SimpleChatMessage = {
      id: '',
      role: msg.role,
      content: flattenAnthropicContent(msg.content),
      timestamp: 0,
    };
    return convertMessageToGemini(flat);
  });
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: folded.max_tokens },
  };
  if (folded.system) {
    const systemText =
      typeof folded.system === 'string'
        ? folded.system
        : folded.system.map((s) => s.text).join('\n\n');
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  return body;
}

/** Serialize an Anthropic request into the exact outbound body for the target. */
function serializeOutbound(request: AnthropicChatRequest, target: ProviderTarget, model: string): string {
  switch (target.apiFormat) {
    case 'anthropic':
      return JSON.stringify(request);
    case 'gemini':
      return JSON.stringify(toGeminiRequest(request, model));
    case 'openai-response': {
      // Build from the OpenAI chat-completions conversion, then remap to the
      // Responses-API envelope: `messages`→`input`, `max_tokens`→`max_output_tokens`.
      const openai = toOpenAIChatRequest(request, model);
      const { messages, max_tokens, ...rest } = openai;
      return JSON.stringify({ ...rest, input: messages, max_output_tokens: max_tokens });
    }
    default:
      return JSON.stringify(toOpenAIChatRequest(request, model));
  }
}

/**
 * Execute 出口② submission. Order is load-bearing: stamped-guard → consent gate
 * → build request + meta → serialize exact outbound bytes → PRE-SEND BACKSTOP →
 * key check → send. The backstop runs over the literal bytes about to leave, so
 * nothing reaches the provider unless it passes. The returned receipt is
 * key-free by construction.
 */
export async function submit(params: SubmitParams): Promise<SubmissionReceipt> {
  const { session, target, model, consent, ruleset, transport, versions } = params;

  if (session.meta.sanitized !== true) throw new NotStampedError();

  // Consent gate (throws ConsentError → 422). Returns the validated content hash.
  const contentHash = assertConsent(session, consent);

  const meta = buildMetaMessage(session, consent, versions);

  if (consent.replayMode === 'turn-by-turn') {
    return submitTurnByTurn({ ...params, contentHash, metaText: serializeMeta(meta) });
  }

  // Single-shot: whole conversation + meta terminal turn, one request.
  const request = buildAnthropicRequest(session, meta, { model });
  const body = serializeOutbound(request, target, model);

  // Pre-send backstop over the EXACT outbound bytes (throws on any blocking hit).
  assertOutboundClean(body, ruleset, params.generatedAt);

  // Key resolved server-side; a missing key is a config error, not a leak.
  if (!params.apiKey) throw new KeyNotConfiguredError(target.id);
  const req: OutboundRequest = {
    url: outboundUrl(target, model),
    method: 'POST',
    headers: authHeaders(target, params.apiKey),
    body,
  };
  const result = await transport(req);

  return {
    submittedAt: params.now ?? new Date().toISOString(),
    targetProviderId: target.id,
    targetModel: model,
    replayMode: 'single-shot',
    requestCount: 1,
    usage: result.usage,
    contentHash,
    consent,
    backstopPassed: true,
    providerStatus: result.status,
  };
}

/**
 * Opt-in turn-by-turn (quadratic) replay: re-post the growing prefix once per
 * turn, with the meta turn on the final request. Every outbound body is backstop
 * -scanned before it is sent. See the change design's cost table — this mode is
 * only reached when the contributor explicitly chose it and saw the (much
 * larger) estimate.
 */
async function submitTurnByTurn(
  params: SubmitParams & { contentHash: string; metaText: string },
): Promise<SubmissionReceipt> {
  const { session, target, model, ruleset, transport } = params;
  if (!params.apiKey) throw new KeyNotConfiguredError(target.id);

  const conv = toAnthropicMessages(session);
  const metaTurn: AnthropicMessage = {
    role: 'user',
    content: [{ type: 'text', text: params.metaText }],
  };
  const prefixes: AnthropicMessage[][] = [];
  for (let i = 1; i <= conv.messages.length; i += 1) prefixes.push(conv.messages.slice(0, i));
  prefixes.push([...conv.messages, metaTurn]); // final ingestion request carries meta

  let usage: SubmissionUsage | null = null;
  let lastStatus = 0;
  for (const messages of prefixes) {
    const request: AnthropicChatRequest = { model, max_tokens: 4096, messages };
    if (conv.system) request.system = conv.system;
    const body = serializeOutbound(request, target, model);
    assertOutboundClean(body, ruleset, params.generatedAt);
    const result = await transport({
      url: outboundUrl(target, model),
      method: 'POST',
      headers: authHeaders(target, params.apiKey),
      body,
    });
    lastStatus = result.status;
    if (result.usage) {
      usage = usage
        ? {
            inputTokens: usage.inputTokens + result.usage.inputTokens,
            outputTokens: usage.outputTokens + result.usage.outputTokens,
          }
        : result.usage;
    }
  }

  return {
    submittedAt: params.now ?? new Date().toISOString(),
    targetProviderId: target.id,
    targetModel: model,
    replayMode: 'turn-by-turn',
    requestCount: prefixes.length,
    usage,
    contentHash: params.contentHash,
    consent: params.consent,
    backstopPassed: true,
    providerStatus: lastStatus,
  };
}
