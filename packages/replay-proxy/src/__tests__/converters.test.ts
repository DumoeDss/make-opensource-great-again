import { describe, expect, it } from 'vitest';

import { createV1ConverterRegistry, V1_CONVERTERS } from '../converters/index.js';
import type { ReplayConversionContext } from '../converters/types.js';
import { sha256Digest } from '../hashing.js';

import {
  ANTHROPIC_REQUEST_BODY,
  CHAT_RESPONSE_BODY,
  RESPONSES_REQUEST_BODY,
  jsonBytes,
} from './fixtures.js';

const ANTHROPIC_CONTEXT: ReplayConversionContext = {
  sourceProtocol: 'anthropic-messages',
  targetFormat: 'openai-chat-completions',
  upstreamBaseUrl: 'https://api.openai.example',
  upstreamModel: 'gpt-4o',
  cliModel: 'claude-3-5-sonnet-20241022',
  streamingRequested: false,
};

const RESPONSES_CONTEXT: ReplayConversionContext = {
  sourceProtocol: 'openai-responses',
  targetFormat: 'openai-chat-completions',
  upstreamBaseUrl: 'https://api.openai.example',
  upstreamModel: 'gpt-4o',
  cliModel: 'codex-mini',
  streamingRequested: false,
};

describe('converter registry matrix', () => {
  it('registers exactly the four v1 converters', () => {
    const registry = createV1ConverterRegistry();
    expect(V1_CONVERTERS.length).toBe(4);
    expect(registry.registeredPairs()).toEqual([
      'anthropic-messages->anthropic-messages',
      'anthropic-messages->openai-chat-completions',
      'openai-responses->openai-chat-completions',
      'openai-responses->openai-responses',
    ]);
  });

  it('selects the correct converter for each supported pair', () => {
    const registry = createV1ConverterRegistry();
    expect(
      registry.lookup('anthropic-messages', 'anthropic-messages')?.id,
    ).toBe('anthropic-passthrough-v1');
    expect(
      registry.lookup('openai-responses', 'openai-responses')?.id,
    ).toBe('openai-responses-passthrough-v1');
    expect(
      registry.lookup('anthropic-messages', 'openai-chat-completions')?.id,
    ).toBe('anthropic-to-openai-chat-v1');
    expect(
      registry.lookup('openai-responses', 'openai-chat-completions')?.id,
    ).toBe('openai-responses-to-openai-chat-v1');
  });

  it('fails closed for every unsupported pair (no nearest-match fallback)', () => {
    const registry = createV1ConverterRegistry();
    const unsupported: Array<
      ['anthropic-messages' | 'openai-responses', 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses']
    > = [
      ['anthropic-messages', 'openai-responses'],
      ['openai-responses', 'anthropic-messages'],
    ];
    for (const [source, target] of unsupported) {
      expect(registry.lookup(source, target)).toBeUndefined();
    }
  });
});

describe('passthrough converters preserve byte-equivalence', () => {
  it('anthropic-passthrough-v1 forwards the body unchanged', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup('anthropic-messages', 'anthropic-messages')!;
    const body = jsonBytes(ANTHROPIC_REQUEST_BODY);
    const converted = converter.convertRequest(body, {
      ...ANTHROPIC_CONTEXT,
      targetFormat: 'anthropic-messages',
    });
    expect(Buffer.from(converted.body).equals(Buffer.from(body))).toBe(true);
    expect(converted.authScheme).toBe('x-api-key');
    expect(converted.targetPath).toBe('/v1/messages');
    expect(converted.headers['anthropic-version']).toBeTruthy();

    // Hash equality proves no mutation.
    expect(sha256Digest(body)).toBe(sha256Digest(converted.body));
  });

  it('openai-responses-passthrough-v1 forwards the body unchanged', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup('openai-responses', 'openai-responses')!;
    const body = jsonBytes(RESPONSES_REQUEST_BODY);
    const converted = converter.convertRequest(body, {
      ...RESPONSES_CONTEXT,
      targetFormat: 'openai-responses',
    });
    expect(Buffer.from(converted.body).equals(Buffer.from(body))).toBe(true);
    expect(converted.authScheme).toBe('bearer');
    expect(converted.targetPath).toBe('/v1/responses');
  });

  it('passthrough response body is forwarded unchanged', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup('anthropic-messages', 'anthropic-messages')!;
    const respBody = jsonBytes({ id: 'msg_x', type: 'message', content: [] });
    const out = converter.convertResponse(respBody, ANTHROPIC_CONTEXT);
    expect(Buffer.from(out).equals(Buffer.from(respBody))).toBe(true);
  });
});

describe('anthropic-to-openai-chat-v1 preserves semantic content', () => {
  it('maps system prompt, user message, and tool schema to Chat shape', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'anthropic-messages',
      'openai-chat-completions',
    )!;
    const body = jsonBytes(ANTHROPIC_REQUEST_BODY);
    const converted = converter.convertRequest(body, ANTHROPIC_CONTEXT);
    const chatBody = JSON.parse(Buffer.from(converted.body).toString('utf8'));

    // System prompt canary survives.
    expect(JSON.stringify(chatBody.messages)).toContain('CANARY-SYSTEM-PROMPT-anthropic');
    // User message canary survives.
    expect(JSON.stringify(chatBody.messages)).toContain('CANARY-USER-MESSAGE-anthropic');
    // Tool schema canary survives in the Chat tools field.
    expect(JSON.stringify(chatBody.tools)).toContain('CANARY-TOOL');
    expect(JSON.stringify(chatBody.tools)).toContain('CANARY-TOOL-DESC');
    // Model is rewritten to the upstream model.
    expect(chatBody.model).toBe('gpt-4o');
    // The proxy forces non-streaming upstream.
    expect(chatBody.stream).toBe(false);
    // Auth scheme is bearer for OpenAI targets.
    expect(converted.authScheme).toBe('bearer');
    expect(converted.targetPath).toBe('/v1/chat/completions');
  });

  it('maps a Chat response back to a syntactically valid Anthropic response', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'anthropic-messages',
      'openai-chat-completions',
    )!;
    const chatResp = jsonBytes(CHAT_RESPONSE_BODY);
    const anthropicBytes = converter.convertResponse(chatResp, ANTHROPIC_CONTEXT);
    const anthropic = JSON.parse(Buffer.from(anthropicBytes).toString('utf8'));

    expect(anthropic.type).toBe('message');
    expect(anthropic.role).toBe('assistant');
    expect(anthropic.content[0].type).toBe('text');
    expect(anthropic.content[0].text).toBe('CANARY-ASSISTANT-TEXT');
    expect(anthropic.stop_reason).toBe('end_turn');
    expect(anthropic.usage.input_tokens).toBe(42);
    expect(anthropic.usage.output_tokens).toBe(7);
    expect(anthropic.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('preserves a multi-turn conversation (system + 2 user + 1 assistant + tool definition)', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'anthropic-messages',
      'openai-chat-completions',
    )!;
    const body = jsonBytes({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      system: 'CANARY-SYSTEM-MULTITURN',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'CANARY-USER-TURN-1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'CANARY-ASSISTANT-TURN-1' }] },
        { role: 'user', content: [{ type: 'text', text: 'CANARY-USER-TURN-2' }] },
      ],
      tools: [
        {
          name: 'CANARY-TOOL-MULTITURN',
          description: 'multi-turn tool',
          input_schema: { type: 'object' },
        },
      ],
      stream: false,
    });
    const converted = converter.convertRequest(body, ANTHROPIC_CONTEXT);
    const chatBody = JSON.parse(Buffer.from(converted.body).toString('utf8'));
    const serialized = JSON.stringify(chatBody);

    // System prompt mapped to the system role.
    expect(chatBody.messages[0].role).toBe('system');
    expect(serialized).toContain('CANARY-SYSTEM-MULTITURN');
    // Every turn preserved with correct content.
    expect(serialized).toContain('CANARY-USER-TURN-1');
    expect(serialized).toContain('CANARY-ASSISTANT-TURN-1');
    expect(serialized).toContain('CANARY-USER-TURN-2');
    // Tool schema retained in Chat tools field.
    expect(serialized).toContain('CANARY-TOOL-MULTITURN');
    // system + 3 turns = 4 messages, no content lost.
    expect(chatBody.messages.length).toBe(4);
  });

  it('fails closed on an unsupported content block type', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'anthropic-messages',
      'openai-chat-completions',
    )!;
    const badBody = jsonBytes({
      model: 'x',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [{ type: 'unknown-block-type', text: 'x' }],
        },
      ],
    });
    expect(() => converter.convertRequest(badBody, ANTHROPIC_CONTEXT)).toThrow();
  });
});

describe('openai-responses-to-openai-chat-v1 preserves semantic content', () => {
  it('maps instructions, input items, and tools to Chat shape', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'openai-responses',
      'openai-chat-completions',
    )!;
    const body = jsonBytes(RESPONSES_REQUEST_BODY);
    const converted = converter.convertRequest(body, RESPONSES_CONTEXT);
    const chatBody = JSON.parse(Buffer.from(converted.body).toString('utf8'));

    // Instructions canary survives as the system message.
    expect(JSON.stringify(chatBody.messages)).toContain('CANARY-INSTRUCTIONS-responses');
    // User message canary survives.
    expect(JSON.stringify(chatBody.messages)).toContain('CANARY-USER-MESSAGE-responses');
    // Tool canary survives.
    expect(JSON.stringify(chatBody.tools)).toContain('CANARY-TOOL');
    // Model rewritten to upstream.
    expect(chatBody.model).toBe('gpt-4o');
    expect(chatBody.stream).toBe(false);
    expect(converted.authScheme).toBe('bearer');
  });

  it('maps a Chat response back to a syntactically valid Responses response', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'openai-responses',
      'openai-chat-completions',
    )!;
    const chatResp = jsonBytes(CHAT_RESPONSE_BODY);
    const responsesBytes = converter.convertResponse(chatResp, RESPONSES_CONTEXT);
    const responses = JSON.parse(Buffer.from(responsesBytes).toString('utf8'));

    expect(responses.object).toBe('response');
    expect(responses.status).toBe('completed');
    expect(responses.output[0].content[0].text).toBe('CANARY-ASSISTANT-TEXT');
    expect(responses.usage.input_tokens).toBe(42);
    expect(responses.usage.output_tokens).toBe(7);
  });

  it('preserves a multi-turn conversation (instruction + messages + function call + output)', () => {
    const registry = createV1ConverterRegistry();
    const converter = registry.lookup(
      'openai-responses',
      'openai-chat-completions',
    )!;
    const body = jsonBytes({
      model: 'codex-mini',
      instructions: 'CANARY-INSTRUCTIONS-MULTITURN',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY-USER-ITEM-1' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CANARY-ASSISTANT-ITEM-1' }] },
        { type: 'function_call', call_id: 'call-canary', name: 'CANARY-FN', arguments: '{"x":1}' },
        { type: 'function_call_output', call_id: 'call-canary', output: 'CANARY-FN-RESULT' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'CANARY-USER-ITEM-2' }] },
      ],
      tools: [
        { type: 'function', name: 'CANARY-FN-TOOL', description: 'fn tool', parameters: { type: 'object' } },
      ],
      stream: false,
    });
    const converted = converter.convertRequest(body, RESPONSES_CONTEXT);
    const chatBody = JSON.parse(Buffer.from(converted.body).toString('utf8'));
    const serialized = JSON.stringify(chatBody);

    // Instruction mapped to the system role.
    expect(chatBody.messages[0].role).toBe('system');
    expect(serialized).toContain('CANARY-INSTRUCTIONS-MULTITURN');
    // Every message item preserved.
    expect(serialized).toContain('CANARY-USER-ITEM-1');
    expect(serialized).toContain('CANARY-ASSISTANT-ITEM-1');
    expect(serialized).toContain('CANARY-USER-ITEM-2');
    // Function call mapped to assistant tool_calls.
    expect(serialized).toContain('CANARY-FN');
    expect(serialized).toContain('call-canary');
    // Function call output mapped to a tool message.
    expect(serialized).toContain('CANARY-FN-RESULT');
    // Tool definition retained.
    expect(serialized).toContain('CANARY-FN-TOOL');
  });
});
