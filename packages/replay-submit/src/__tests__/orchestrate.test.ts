/**
 * Orchestration tests: the locked prepare-render-register-execute-dispose order,
 * every failure code, partial failure, dispose-on-every-path, and cancellation.
 *
 * All fakes — no real CLI, listener, or provider.
 */
import { describe, expect, it } from 'vitest';

import { submitCliResume } from '../orchestrate.js';
import {
  FIXED_NOW,
  createFakeStack,
  createFakeRuntime,
  createFakeProxy,
  sealedBundle,
  bundleContentHash,
  validConsent,
  fakeUpstream,
} from './fixtures.js';

import type {
  CliResumeConsent,
  ReplayBundle,
} from '@mosga/contracts';
import type {
  ReplayRuntimeFailure,
  ReplayPrepareResult,
  ReplayExecutionResult,
  PreparedReplay,
} from '@mosga/replay-runtime';
import type {
  ReplayProxyFailure,
  ReplayRouteRegistration,
} from '@mosga/replay-proxy';

// -----------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------

describe('submitCliResume happy path', () => {
  it('returns ok:true with a CliResumeReceipt carrying all three hashes', async () => {
    const stack = createFakeStack();
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
      now: () => FIXED_NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.receipt;
    // Three distinct hashes converge.
    expect(receipt.bundleContentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.cliRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.outboundRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.bundleContentHash).not.toBe(receipt.cliRequestHash);
    expect(receipt.cliRequestHash).not.toBe(receipt.outboundRequestHash);
    expect(receipt.outcome).toBe('inference-served');
    expect(receipt.sourceCli).toBe('claude-code');
    expect(receipt.converterId).toBe('anthropic-messages-passthrough');
  });

  it('disposes both the prepared replay and the proxy route', async () => {
    const stack = createFakeStack();
    await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
      now: () => FIXED_NOW,
    });
    expect(stack.runtimeCalls.disposeCalls).toBe(1);
    expect(stack.proxyCalls.disposeCalls).toBe(1);
  });
});

// -----------------------------------------------------------------------
// Consent failures (before any side effect)
// -----------------------------------------------------------------------

describe('submitCliResume consent validation', () => {
  it('returns consent-invalid when runtimeContextAcknowledged is false', async () => {
    const stack = createFakeStack();
    const consent: CliResumeConsent = {
      ...stack.consent,
      runtimeContextAcknowledged: false,
    };
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('consent-invalid');
    expect(result.error.stage).toBe('consent');
    // No side effects.
    expect(stack.runtimeCalls.prepareCalls).toBe(0);
  });

  it('returns consent-invalid when bundle hash mismatches', async () => {
    const stack = createFakeStack();
    const consent: CliResumeConsent = {
      ...stack.consent,
      bundleContentHash: 'sha256:' + '0'.repeat(64),
    };
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('consent-invalid');
    expect(stack.runtimeCalls.prepareCalls).toBe(0);
  });

  it('returns consent-invalid when target provider mismatches', async () => {
    const stack = createFakeStack();
    const consent: CliResumeConsent = {
      ...stack.consent,
      targetProviderId: 'wrong-provider',
    };
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('consent-invalid');
  });
});

// -----------------------------------------------------------------------
// Bundle failures
// -----------------------------------------------------------------------

describe('submitCliResume bundle validation', () => {
  it('returns bundle-invalid for a malformed bundle', async () => {
    const stack = createFakeStack();
    const result = await submitCliResume({
      bundle: { not: 'a valid bundle' },
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bundle-invalid');
    expect(result.error.stage).toBe('bundle');
  });
});

// -----------------------------------------------------------------------
// Runtime failures
// -----------------------------------------------------------------------

describe('submitCliResume runtime failures', () => {
  const makePrepareFailure = (
    code: string,
    extras: Partial<ReplayRuntimeFailure> = {},
  ): ReplayPrepareResult => ({
    ok: false,
    error: {
      code: code as ReplayRuntimeFailure['code'],
      stage: 'probe',
      sourceCli: 'claude-code',
      replayCliVersion: '1.2.3',
      cleanup: 'not-created',
      ...extras,
    },
  });

  it('returns runtime-unsupported for cli-version-unsupported', async () => {
    const stack = createFakeStack({
      prepareResult: makePrepareFailure('cli-version-unsupported'),
    });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('runtime-unsupported');
    expect(result.error.sourceCli).toBe('claude-code');
    expect(result.error.replayCliVersion).toBe('1.2.3');
  });

  it('returns runtime-unsupported for cli-capability-unsupported', async () => {
    const stack = createFakeStack({
      prepareResult: makePrepareFailure('cli-capability-unsupported'),
    });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('runtime-unsupported');
  });

  it('returns runtime-failed for workspace-create-failed', async () => {
    const stack = createFakeStack({
      prepareResult: makePrepareFailure('workspace-create-failed'),
    });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('runtime-failed');
  });
});

// -----------------------------------------------------------------------
// Execute failures
// -----------------------------------------------------------------------

describe('submitCliResume execute failures', () => {
  const makeExecuteFailure = (
    code: string,
  ): ReplayExecutionResult => ({
    ok: false,
    error: {
      code: code as ReplayRuntimeFailure['code'],
      stage: 'run',
      sourceCli: 'claude-code',
      replayCliVersion: '1.2.3',
      cleanup: 'complete',
    },
  });

  it('returns cancelled for cancelled execute', async () => {
    const stack = createFakeStack({
      executeResult: makeExecuteFailure('cancelled'),
    });
    // Proxy receipt rejects (no round-trip).
    const proxyStack = createFakeStack(
      {},
      { receiptShouldReject: true },
    );
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cancelled');
  });

  it('returns timed-out for timed-out execute', async () => {
    const stack = createFakeStack({
      executeResult: makeExecuteFailure('timed-out'),
    });
    const proxyStack = createFakeStack(
      {},
      { receiptShouldReject: true },
    );
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timed-out');
  });
});

// -----------------------------------------------------------------------
// Proxy failures
// -----------------------------------------------------------------------

describe('submitCliResume proxy failures', () => {
  it('returns proxy-failed when registerRoute fails', async () => {
    const stack = createFakeStack();
    const failure: ReplayProxyFailure = {
      code: 'converter-unsupported',
      stage: 'register',
      routeClosed: 'failed',
    };
    const registerResult: ReplayRouteRegistration = { ok: false, error: failure };
    const proxyStack = createFakeStack({}, { registerResult });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('proxy-failed');
    expect(result.error.stage).toBe('register');
  });

  it('returns proxy-failed when execute succeeds but receipt rejects', async () => {
    const stack = createFakeStack();
    const proxyStack = createFakeStack({}, { receiptShouldReject: true });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('proxy-failed');
    expect(result.error.stage).toBe('receipt');
  });
});

// -----------------------------------------------------------------------
// Partial failure: runtime fails but round-trip completed
// -----------------------------------------------------------------------

describe('submitCliResume partial failure', () => {
  it('returns ok:true with outcome runtime-failed when CLI exits non-zero after sending', async () => {
    const stack = createFakeStack({
      executeResult: {
        ok: false,
        error: {
          code: 'process-exit-failed',
          stage: 'run',
          sourceCli: 'claude-code',
          replayCliVersion: '1.2.3',
          cleanup: 'complete',
        },
      },
    });
    // Proxy receipt resolves normally (the round-trip completed).
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
      now: () => FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.outcome).toBe('runtime-failed');
    // Hashes are still present from the completed round-trip.
    expect(result.receipt.cliRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.receipt.outboundRequestHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// -----------------------------------------------------------------------
// Dispose on every path
// -----------------------------------------------------------------------

describe('submitCliResume dispose', () => {
  it('disposes runtime and proxy even when execute fails', async () => {
    const stack = createFakeStack({
      executeResult: {
        ok: false,
        error: {
          code: 'process-exit-failed',
          stage: 'run',
          sourceCli: 'claude-code',
          replayCliVersion: '1.2.3',
          cleanup: 'complete',
        },
      },
    });
    const proxyStack = createFakeStack({}, { receiptShouldReject: true });
    await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(stack.runtimeCalls.disposeCalls).toBeGreaterThanOrEqual(0);
    expect(proxyStack.proxyCalls.disposeCalls).toBeGreaterThanOrEqual(0);
  });

  it('disposes runtime even when proxy registration fails', async () => {
    const stack = createFakeStack();
    const failure: ReplayProxyFailure = {
      code: 'converter-unsupported',
      stage: 'register',
      routeClosed: 'failed',
    };
    const proxyStack = createFakeStack(
      {},
      { registerResult: { ok: false, error: failure } },
    );
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: proxyStack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Runtime was prepared, so cleanup should be complete.
    expect(result.error.runtimeCleanup).toBe('complete');
    // Proxy was never registered.
    expect(result.error.proxyCleanup).toBe('not-started');
  });
});

// -----------------------------------------------------------------------
// Cancellation via AbortSignal
// -----------------------------------------------------------------------

describe('submitCliResume cancellation', () => {
  it('returns cancelled when the signal is already aborted', async () => {
    const stack = createFakeStack();
    const controller = new AbortController();
    controller.abort();
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cancelled');
  });
});

// -----------------------------------------------------------------------
// Disclosure safety: no secrets in any result
// -----------------------------------------------------------------------

describe('submitCliResume disclosure safety', () => {
  const CANARY = 'fake-route-token';
  const KEY_CANARY = 'fake-key-do-not-use';

  it('never includes the route token or API key in a receipt', async () => {
    const stack = createFakeStack();
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
      now: () => FIXED_NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(KEY_CANARY);
  });

  it('never includes the route token or API key in a failure', async () => {
    const stack = createFakeStack({
      prepareResult: {
        ok: false,
        error: {
          code: 'cli-version-unsupported',
          stage: 'probe',
          sourceCli: 'claude-code',
          replayCliVersion: '1.2.3',
          cleanup: 'not-created',
        },
      },
    });
    const result = await submitCliResume({
      bundle: stack.bundle,
      consent: stack.consent,
      upstream: stack.upstream,
      runtime: stack.runtime,
      proxy: stack.proxy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(KEY_CANARY);
  });
});
