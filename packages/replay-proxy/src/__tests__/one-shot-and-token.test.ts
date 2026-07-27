import { describe, expect, it } from 'vitest';

import { createReplayProxy } from '../index.js';

import {
  ANTHROPIC_REQUEST_BODY,
  CLAUDE_REQUIREMENT,
  CLAUDE_TARGET_CHAT,
  createRecordingTransport,
  jsonResponse,
  postToProxy,
} from './fixtures.js';

describe('one-shot latch and route-token enforcement', () => {
  it('rejects a second concurrent request with 429 route-already-used', async () => {
    // Use a delayed transport so both requests arrive while the first is in flight.
    let releaseTransport: () => void = () => {};
    let signalTransportReached: (() => void) | null = null;
    const transportReached = new Promise<void>((resolve) => {
      signalTransportReached = resolve;
    });
    const transport = async () => {
      signalTransportReached?.();
      signalTransportReached = null;
      await new Promise<void>((resolve) => {
        releaseTransport = resolve;
      });
      return jsonResponse(200, {
        id: 'chatcmpl-ok',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const proxy = createReplayProxy({ transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    // Fire the first request (don't await — it's held by the delayed transport).
    const firstPromise = postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    // Wait deterministically until the first request has claimed the latch.
    await transportReached;
    // The second request arrives while the first is in flight → 429.
    const second = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(second.status).toBe(429);
    expect(second.body).not.toContain(binding.routeToken);

    // Release the first request.
    releaseTransport();
    const first = await firstPromise;
    expect(first.status).toBe(200);

    await proxy.shutdown();
  });

  it('rejects a missing token with 401 route-token-invalid', async () => {
    const rec = createRecordingTransport(jsonResponse(200, {}));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY, {
      authorization: '',
    });
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(binding.routeToken);

    // No upstream forward occurred.
    expect(rec.requests).toHaveLength(0);

    await proxy.shutdown();
  });

  it('rejects a malformed token header with 401', async () => {
    const rec = createRecordingTransport(jsonResponse(200, {}));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY, {
      authorization: 'Basic not-a-bearer',
    });
    expect(res.status).toBe(401);
    expect(rec.requests).toHaveLength(0);
    await proxy.shutdown();
  });

  it('rejects a mismatched token with 401', async () => {
    const rec = createRecordingTransport(jsonResponse(200, {}));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY, {
      authorization: 'Bearer wrong-token-value',
    });
    expect(res.status).toBe(401);
    expect(rec.requests).toHaveLength(0);
    await proxy.shutdown();
  });

  it('rejects an oversized body with a generic 400 without consuming the route', async () => {
    const rec = createRecordingTransport(
      jsonResponse(200, {
        id: 'chatcmpl-ok',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const proxy = createReplayProxy({
      transport: rec.transport,
      maxRequestBytes: 200,
    });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    // First request: the full fixture body is well over 200 bytes → oversized.
    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(400);
    expect(rec.requests).toHaveLength(0);

    // The route is NOT consumed — a subsequent small valid request still succeeds.
    const smallBody = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    };
    const res2 = await postToProxy(binding.baseUrl, binding.routeToken, smallBody);
    expect(res2.status).toBe(200);
    expect(rec.requests).toHaveLength(1);

    await proxy.shutdown();
  });

  it('does NOT burn the route on an invalid token (subsequent valid token succeeds)', async () => {
    const rec = createRecordingTransport(
      jsonResponse(200, {
        id: 'chatcmpl-ok',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    // First request: invalid token → 401, route NOT consumed.
    const bad = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY, {
      authorization: 'Bearer wrong-token-value',
    });
    expect(bad.status).toBe(401);
    expect(rec.requests).toHaveLength(0);

    // Second request: valid token → 200, route consumed.
    const good = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(good.status).toBe(200);
    expect(rec.requests).toHaveLength(1);

    const receipt = await reg.handle.receipt;
    expect(receipt.outcome).toBe('inference-served');

    await proxy.shutdown();
  });

  it('closes the listener after a completed round-trip', async () => {
    const rec = createRecordingTransport(
      jsonResponse(200, {
        id: 'chatcmpl-done',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    const res = await postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY);
    expect(res.status).toBe(200);

    // Wait for the listener to close.
    await reg.handle.receipt;

    // A subsequent sequential request gets connection-refused, proving the
    // listener closed. (The latch-level 429 is covered by the concurrent test.)
    await expect(
      postToProxy(binding.baseUrl, binding.routeToken, ANTHROPIC_REQUEST_BODY),
    ).rejects.toThrow();

    await proxy.shutdown();
  });
});
