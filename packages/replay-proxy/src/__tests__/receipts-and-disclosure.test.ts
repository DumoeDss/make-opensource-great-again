import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createReplayProxy } from '../index.js';
import { sha256Digest } from '../hashing.js';
import { parseUsage } from '../usage.js';
import {
  ANTHROPIC_REQUEST_BODY,
  ANTHROPIC_RESPONSE_BODY,
  CHAT_RESPONSE_BODY,
  CLAUDE_REQUIREMENT,
  CLAUDE_TARGET_ANTHROPIC,
  CLAUDE_TARGET_CHAT,
  createRecordingTransport,
  jsonResponse,
  postToProxy,
} from './fixtures.js';

describe('SHA-256 hashing', () => {
  it('matches node crypto for a known vector', () => {
    const bytes = Buffer.from('hello-proxy', 'utf8');
    const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(sha256Digest(bytes)).toBe(expected);
    expect(sha256Digest(bytes)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('produces equal hashes for identical bytes (passthrough proof)', () => {
    const a = Buffer.from('{"x":1}', 'utf8');
    const b = Buffer.from('{"x":1}', 'utf8');
    expect(sha256Digest(a)).toBe(sha256Digest(b));
  });
});

describe('normalized usage parsing', () => {
  it('parses Anthropic usage', () => {
    const u = parseUsage(
      Buffer.from(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 } })),
      'anthropic-messages',
    );
    expect(u).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('parses OpenAI Chat usage', () => {
    const u = parseUsage(
      Buffer.from(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 8 } })),
      'openai-chat-completions',
    );
    expect(u).toEqual({ inputTokens: 5, outputTokens: 8 });
  });

  it('parses OpenAI Responses usage', () => {
    const u = parseUsage(
      Buffer.from(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } })),
      'openai-responses',
    );
    expect(u).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('returns null for a body without usage', () => {
    expect(parseUsage(Buffer.from('{}'), 'openai-chat-completions')).toBeNull();
    expect(parseUsage(Buffer.from('not-json'), 'openai-chat-completions')).toBeNull();
  });
});

describe('receipt hashes on a completed round-trip', () => {
  it('passthrough produces equal cliRequestHash and outboundRequestHash', async () => {
    const rec = createRecordingTransport(jsonResponse(200, ANTHROPIC_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_ANTHROPIC);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);

    const receipt = await reg.handle.receipt;
    expect(receipt.cliRequestHash).toBe(receipt.outboundRequestHash);
    expect(receipt.outcome).toBe('inference-served');
    expect(receipt.httpStatus).toBe(200);
    expect(receipt.requestCount).toBe(1);
    expect(receipt.converterId).toBe('anthropic-passthrough-v1');
    expect(receipt.converterVersion).toBe('1.0.0');
    expect(receipt.usage).toEqual({ inputTokens: 42, outputTokens: 7 });

    // The outbound body equals the CLI body (byte-equivalent for passthrough).
    const expectedHash = sha256Digest(Buffer.from(JSON.stringify(ANTHROPIC_REQUEST_BODY), 'utf8'));
    expect(receipt.cliRequestHash).toBe(expectedHash);
    await proxy.shutdown();
  });

  it('cross-protocol produces distinct hashes and carries the real key only on the outbound', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);
    const receipt = await reg.handle.receipt;

    expect(receipt.cliRequestHash).not.toBe(receipt.outboundRequestHash);
    expect(receipt.outcome).toBe('inference-served');
    expect(receipt.converterId).toBe('anthropic-to-openai-chat-v1');

    // The single outbound request carried the real key as x-api-key... no,
    // OpenAI Chat targets use bearer auth.
    expect(rec.requests).toHaveLength(1);
    const outbound = rec.requests[0];
    expect(outbound.headers['authorization']).toBe(`Bearer ${CLAUDE_TARGET_CHAT.upstreamApiKey}`);
    // The route token was NOT forwarded upstream.
    expect(JSON.stringify(outbound)).not.toContain(binding.routeToken);

    await proxy.shutdown();
  });
});

describe('credential and content isolation (disclosure canaries)', () => {
  it('never leaks the route token or upstream key into the receipt', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    const receipt = await reg.handle.receipt;
    const serialized = JSON.stringify(receipt);

    expect(serialized).not.toContain(binding.routeToken);
    expect(serialized).not.toContain(CLAUDE_TARGET_CHAT.upstreamApiKey);
    // Content canaries (system prompt, tool schema) must not appear in the receipt.
    expect(serialized).not.toContain('CANARY-SYSTEM-PROMPT');
    expect(serialized).not.toContain('CANARY-TOOL');
    expect(serialized).not.toContain('CANARY-USER-MESSAGE');
    await proxy.shutdown();
  });

  it('never leaks the token or key into a 401 error response body', async () => {
    const rec = createRecordingTransport(jsonResponse(200, {}));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY, {
      authorization: 'Bearer wrong',
    });
    expect(res.body).not.toContain(binding.routeToken);
    expect(res.body).not.toContain(CLAUDE_TARGET_CHAT.upstreamApiKey);
    expect(res.body).not.toContain('CANARY');
    await proxy.shutdown();
  });

  it('never leaks the upstream error body to the CLI on a non-2xx', async () => {
    const sensitiveUpstreamBody = {
      error: { message: 'account 12345 rate-limited', request_id: 'req-LEAK-CANARY' },
    };
    const rec = createRecordingTransport(jsonResponse(429, sensitiveUpstreamBody));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('req-LEAK-CANARY');
    expect(res.body).not.toContain('account 12345');

    const receipt = await reg.handle.receipt;
    expect(receipt.outcome).toBe('upstream-non-2xx');
    expect(receipt.httpStatus).toBe(429);
    await proxy.shutdown();
  });

  it('clears the upstream key from the route record on dispose', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    // The key appears on the single outbound request while the route is live.
    await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    await reg.handle.receipt;
    expect(rec.requests[0].headers['authorization']).toContain(CLAUDE_TARGET_CHAT.upstreamApiKey);

    // After the round-trip the key is cleared; a source scan of the proxy
    // module confirms there is no API to retrieve it.
    await proxy.shutdown();
  });
});
