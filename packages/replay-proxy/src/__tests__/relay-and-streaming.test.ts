import { describe, expect, it } from 'vitest';

import { createReplayProxy } from '../index.js';

import {
  ANTHROPIC_REQUEST_BODY,
  ANTHROPIC_RESPONSE_BODY,
  ANTHROPIC_STREAMING_REQUEST_BODY,
  CHAT_RESPONSE_BODY,
  CLAUDE_REQUIREMENT,
  CLAUDE_TARGET_ANTHROPIC,
  CLAUDE_TARGET_CHAT,
  CODEX_REQUIREMENT,
  CODEX_TARGET_CHAT,
  CODEX_TARGET_RESPONSES,
  createRecordingTransport,
  jsonResponse,
  postToProxy,
  RESPONSES_REQUEST_BODY,
  RESPONSES_RESPONSE_BODY,
} from './fixtures.js';

describe('non-streaming relay correctness', () => {
  it('relays a passthrough Anthropic response unchanged to the Claude CLI', async () => {
    const rec = createRecordingTransport(jsonResponse(200, ANTHROPIC_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_ANTHROPIC);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('message');
    expect(body.content[0].text).toBe('CANARY-ASSISTANT-TEXT');
    await proxy.shutdown();
  });

  it('relays a cross-protocol Anthropic-format response to the Claude CLI', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    // The CLI receives a syntactically valid Anthropic Messages response.
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].type).toBe('text');
    expect(body.content[0].text).toBe('CANARY-ASSISTANT-TEXT');
    await proxy.shutdown();
  });

  it('relays a cross-protocol Responses-format response to the Codex CLI', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CODEX_REQUIREMENT, CODEX_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, RESPONSES_REQUEST_BODY);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output[0].content[0].text).toBe('CANARY-ASSISTANT-TEXT');
    await proxy.shutdown();
  });
});

describe('streaming synthesis', () => {
  it('synthesizes a valid Anthropic SSE stream when the CLI requested streaming', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_STREAMING_REQUEST_BODY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    // Parse the SSE: each event is `event: <type>\ndata: <json>\n\n`.
    const events = parseSseEvents(res.body);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('message_start');
    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes).toContain('message_stop');

    // The content delta carries the completion text.
    const delta = events.find((e) => e.type === 'content_block_delta');
    expect(delta?.data.delta.text).toBe('CANARY-ASSISTANT-TEXT');
    await proxy.shutdown();
  });

  it('synthesizes a valid Responses SSE stream when the CLI requested streaming', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    // Use a Codex-style request by swapping the requirement to a Codex/Responses pair.
    await proxy.shutdown();
    const proxy2 = createReplayProxy({ transport: rec.transport });
    const reg2 = await proxy2.registerRoute(CODEX_REQUIREMENT, CODEX_TARGET_CHAT);
    if (!reg2.ok) throw new Error('registration failed');

    const streamingBody = { ...RESPONSES_REQUEST_BODY, stream: true };
    const res = await postToProxy(reg2.handle.binding.baseUrl, reg2.handle.binding.routeToken, streamingBody);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSseEvents(res.body);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('response.created');
    expect(eventTypes).toContain('response.completed');

    const completed = events.find((e) => e.type === 'response.completed');
    expect(completed?.data.response.status).toBe('completed');
    await proxy2.shutdown();
  });
});

describe('upstream failure relay', () => {
  it('relays a generic 502 on a non-2xx upstream without leaking the body', async () => {
    const rec = createRecordingTransport(
      jsonResponse(500, { error: 'internal LEAK-CANARY-detail' }),
    );
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('LEAK-CANARY');

    const receipt = await reg.handle.receipt;
    expect(receipt.outcome).toBe('upstream-non-2xx');
    expect(receipt.httpStatus).toBe(500);
    await proxy.shutdown();
  });

  it('relays a generic 502 on a network failure and records upstream-request-failed', async () => {
    const rec = createRecordingTransport(jsonResponse(200, {}));
    rec.setThrow(new Error('ECONNREFUSED'));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('ECONNREFUSED');

    const receipt = await reg.handle.receipt;
    expect(receipt.outcome).toBe('upstream-request-failed');
    expect(receipt.httpStatus).toBe(0);
    await proxy.shutdown();
  });
});

describe('full end-to-end round-trips (both source protocols)', () => {
  it('Claude (anthropic) -> Anthropic-native passthrough: binding, conversion, hashes, receipt', async () => {
    const rec = createRecordingTransport(jsonResponse(200, ANTHROPIC_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_ANTHROPIC);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);
    const receipt = await reg.handle.receipt;

    // Valid binding.
    expect(new URL(reg.handle.binding.baseUrl).protocol).toBe('http:');
    // Single accepted request.
    expect(rec.requests).toHaveLength(1);
    // Passthrough: equal hashes.
    expect(receipt.cliRequestHash).toBe(receipt.outboundRequestHash);
    // Correct converter recorded.
    expect(receipt.converterId).toBe('anthropic-passthrough-v1');
    expect(receipt.routeClosed).toBe('single-shot-completed');
    await proxy.shutdown();
  });

  it('Codex (responses) -> Responses-native passthrough: binding, conversion, hashes, receipt', async () => {
    const rec = createRecordingTransport(jsonResponse(200, RESPONSES_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CODEX_REQUIREMENT, CODEX_TARGET_RESPONSES);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, RESPONSES_REQUEST_BODY);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('response');

    const receipt = await reg.handle.receipt;
    expect(receipt.cliRequestHash).toBe(receipt.outboundRequestHash);
    expect(receipt.converterId).toBe('openai-responses-passthrough-v1');
    await proxy.shutdown();
  });

  it('Claude -> OpenAI Chat cross-protocol: conversion, distinct hashes, receipt', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);
    const receipt = await reg.handle.receipt;

    expect(receipt.cliRequestHash).not.toBe(receipt.outboundRequestHash);
    expect(receipt.converterId).toBe('anthropic-to-openai-chat-v1');
    // Outbound went to the chat completions path with bearer auth.
    expect(rec.requests[0].url).toContain('/v1/chat/completions');
    await proxy.shutdown();
  });

  it('Codex -> OpenAI Chat cross-protocol: conversion, distinct hashes, receipt', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CODEX_REQUIREMENT, CODEX_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const res = await postToProxy(reg.handle.binding.baseUrl, reg.handle.binding.routeToken, RESPONSES_REQUEST_BODY);
    expect(res.status).toBe(200);
    const receipt = await reg.handle.receipt;

    expect(receipt.cliRequestHash).not.toBe(receipt.outboundRequestHash);
    expect(receipt.converterId).toBe('openai-responses-to-openai-chat-v1');
    await proxy.shutdown();
  });
});

// ---------------------------------------------------------------------------
// SSE parser.
// ---------------------------------------------------------------------------

interface SseEvent {
  readonly type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
}

function parseSseEvents(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  const chunks = raw.split('\n\n');
  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let type = '';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) type = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (type && dataLine) {
      events.push({ type, data: JSON.parse(dataLine) });
    }
  }
  return events;
}
