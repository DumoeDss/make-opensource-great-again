import { describe, expect, it } from 'vitest';

import { createReplayProxy } from '../index.js';

import {
  ANTHROPIC_REQUEST_BODY,
  CHAT_RESPONSE_BODY,
  CLAUDE_REQUIREMENT,
  CLAUDE_TARGET_CHAT,
  CODEX_REQUIREMENT,
  CODEX_TARGET_CHAT,
  createRecordingTransport,
  jsonResponse,
  postToProxy,
} from './fixtures.js';

describe('dispose lifecycle', () => {
  it('rejects the receipt with route-disposed when disposed before any request', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const disposeResult = await reg.handle.dispose();
    expect(disposeResult.ok).toBe(true);
    expect(disposeResult.routeClosed).toBe('disposed-unused');

    const settled = await reg.handle.receipt.catch((e: unknown) => e);
    expect(settled).toMatchObject({ code: 'route-disposed' });

    // No upstream forward occurred.
    expect(rec.requests).toHaveLength(0);
    await proxy.shutdown();
  });

  it('rejects the receipt with route-disposed when disposed mid-round-trip', async () => {
    let releaseTransport: (() => void) | null = null;
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
      return jsonResponse(200, CHAT_RESPONSE_BODY);
    };
    const proxy = createReplayProxy({ transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');
    const { binding } = reg.handle;

    // Fire the request (don't await — it's mid-flight).
    const requestPromise = postToProxy(
      binding.baseUrl,
      binding.routeToken,
      ANTHROPIC_REQUEST_BODY,
    );

    // Wait deterministically until the handler reaches the transport (latch
    // already claimed, state = forwarding).
    await transportReached;

    const disposeResult = await reg.handle.dispose();
    expect(disposeResult.ok).toBe(true);
    expect(disposeResult.routeClosed).toBe('disposed-mid-round-trip');

    // Release the transport; the in-flight fetch is aborted by dispose.
    releaseTransport?.();

    // The request to the proxy may error (connection reset) — tolerate it.
    await requestPromise.catch(() => {});

    const settled = await reg.handle.receipt.catch((e: unknown) => e);
    expect(settled).toMatchObject({ code: 'route-disposed' });
    await proxy.shutdown();
  });

  it('is idempotent on double-dispose', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const reg = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    if (!reg.ok) throw new Error('registration failed');

    const first = await reg.handle.dispose();
    const second = await reg.handle.dispose();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await proxy.shutdown();
  });
});

describe('shutdown lifecycle', () => {
  it('disposes every active route and refuses further registration', async () => {
    const rec = createRecordingTransport(jsonResponse(200, CHAT_RESPONSE_BODY));
    const proxy = createReplayProxy({ transport: rec.transport });
    const regA = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    const regB = await proxy.registerRoute(CODEX_REQUIREMENT, CODEX_TARGET_CHAT);
    if (!regA.ok || !regB.ok) throw new Error('registration failed');

    const result = await proxy.shutdown();
    expect(result.ok).toBe(true);
    expect(result.routesClosed).toBe(2);

    // Both receipts settle with a stable failure.
    const settledA = await regA.handle.receipt.catch((e: unknown) => e);
    const settledB = await regB.handle.receipt.catch((e: unknown) => e);
    expect(settledA).toMatchObject({ code: 'route-disposed' });
    expect(settledB).toMatchObject({ code: 'route-disposed' });

    // Further registration is refused.
    const regC = await proxy.registerRoute(CLAUDE_REQUIREMENT, CLAUDE_TARGET_CHAT);
    expect(regC.ok).toBe(false);
    if (!regC.ok) expect(regC.error.code).toBe('proxy-shutdown');
  });

  it('shutdown is idempotent', async () => {
    const proxy = createReplayProxy();
    const first = await proxy.shutdown();
    const second = await proxy.shutdown();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
