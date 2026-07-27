/**
 * Test fixtures for @mosga/replay-submit.
 *
 * All fakes — no real CLI launch, no real listener bind, no real provider call.
 * The sealed bundle comes from the bundle foundation's test fixtures (reused
 * via direct import); the fake runtime/proxy implement the public interfaces
 * with canned results.
 */
import type {
  CliResumeConsent,
  ReplayBundle,
  SourceCli,
  SubmissionUsage,
} from '@mosga/contracts';
import { sealReplayBundle } from '@mosga/replay-bundle';
import type {
  ExecutePreparedReplayInput,
  PreparedReplay,
  ReplayExecutionResult,
  ReplayPreparationObservation,
  ReplayPrepareResult,
  ReplayRuntime,
  ReplayRouteRequirement,
} from '@mosga/replay-runtime';
import type {
  ReplayProxy,
  ReplayProxyReceipt,
  ReplayRouteHandle,
  ReplayRouteRegistration,
  ReplayUpstreamTarget,
} from '@mosga/replay-proxy';

import {
  makeReviewedPayload,
  refreshReviewedDraftHash,
} from '../../../replay-bundle/src/__tests__/fixtures.js';

export const FIXED_NOW = '2026-07-27T12:00:00.000Z';

// -----------------------------------------------------------------------
// Sealed bundle
// -----------------------------------------------------------------------

export function sealedBundle(): ReplayBundle {
  const payload = refreshReviewedDraftHash(makeReviewedPayload());
  return sealReplayBundle(payload);
}

export function bundleContentHash(bundle: ReplayBundle): `sha256:${string}` {
  return bundle.integrity.contentHash as `sha256:${string}`;
}

// -----------------------------------------------------------------------
// Consent matching the sealed bundle
// -----------------------------------------------------------------------

export function validConsent(
  bundle: ReplayBundle = sealedBundle(),
): CliResumeConsent {
  return {
    consentVersion: 'cli-resume-0.1.0',
    tosRiskAcknowledged: true,
    fullRetentionAcknowledged: true,
    runtimeContextAcknowledged: true,
    bundleContentHash: bundleContentHash(bundle),
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
    replayMode: 'cli-resume',
    instructionPolicy: 'sanitized-snapshot',
    skillPolicy: 'cli-discovery-read-only',
    confirmedAt: '2026-07-27T11:59:00.000Z',
  };
}

// -----------------------------------------------------------------------
// Upstream target (fake key — never real)
// -----------------------------------------------------------------------

export function fakeUpstream(): ReplayUpstreamTarget {
  return {
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
    upstreamBaseUrl: 'https://fake-upstream.example.com',
    upstreamApiKey: 'fake-key-do-not-use',
    upstreamApiFormat: 'anthropic-messages',
  };
}

// -----------------------------------------------------------------------
// Fake runtime
// -----------------------------------------------------------------------

export interface FakeRuntimeConfig {
  readonly prepareResult?: ReplayPrepareResult;
  readonly executeResult?: ReplayExecutionResult;
  readonly disposeShouldThrow?: boolean;
}

export interface FakeRuntimeCallLog {
  prepareCalls: number;
  executeCalls: number;
  disposeCalls: number;
}

export function createFakeRuntime(
  config: FakeRuntimeConfig = {},
): { runtime: ReplayRuntime; calls: FakeRuntimeCallLog } {
  const calls: FakeRuntimeCallLog = {
    prepareCalls: 0,
    executeCalls: 0,
    disposeCalls: 0,
  };

  const observation: ReplayPreparationObservation = {
    sourceCli: 'claude-code' as SourceCli,
    bundleContentHash: 'sha256:' + 'a'.repeat(64),
    recordedCliVersion: '1.2.3',
    replayCliVersion: '1.2.3',
    capabilityProfileId: 'claude-code-2.1-headless-resume-v1',
    delivery: {
      schemaVersion: '1.0.0',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
    },
    routeRequirement: {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
    } as ReplayRouteRequirement,
  };

  const defaultPrepareResult: ReplayPrepareResult = {
    ok: true,
    prepared: {
      observation,
      async execute(_input: ExecutePreparedReplayInput): Promise<ReplayExecutionResult> {
        calls.executeCalls += 1;
        return (
          config.executeResult ?? {
            ok: true,
            observation,
            startedAt: FIXED_NOW,
            completedAt: FIXED_NOW,
            durationMs: 100,
            exitStatus: 0,
          }
        );
      },
      async dispose() {
        calls.disposeCalls += 1;
        if (config.disposeShouldThrow) throw new Error('dispose failed');
        return { ok: true, cleanup: 'complete' as const };
      },
    },
  };

  const runtime: ReplayRuntime = {
    async prepare() {
      calls.prepareCalls += 1;
      return config.prepareResult ?? defaultPrepareResult;
    },
  };

  return { runtime, calls };
}

// -----------------------------------------------------------------------
// Fake proxy
// -----------------------------------------------------------------------

export interface FakeProxyConfig {
  readonly registerResult?: ReplayRouteRegistration;
  readonly receipt?: ReplayProxyReceipt | null;
  readonly receiptShouldReject?: boolean;
  readonly disposeShouldThrow?: boolean;
}

export interface FakeProxyCallLog {
  registerCalls: number;
  disposeCalls: number;
}

export function createFakeProxy(
  config: FakeProxyConfig = {},
): { proxy: ReplayProxy; calls: FakeProxyCallLog } {
  const calls: FakeProxyCallLog = {
    registerCalls: 0,
    disposeCalls: 0,
  };

  const defaultReceipt: ReplayProxyReceipt = {
    sourceCli: 'claude-code',
    sourceWireProtocol: 'anthropic-messages',
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
    upstreamApiFormat: 'anthropic-messages',
    converterId: 'anthropic-messages-passthrough',
    converterVersion: '1.0.0',
    cliRequestHash: 'sha256:' + 'b'.repeat(64),
    outboundRequestHash: 'sha256:' + 'c'.repeat(64),
    requestCount: 1,
    httpStatus: 200,
    outcome: 'inference-served',
    usage: { inputTokens: 100, outputTokens: 50 } as SubmissionUsage,
    startedAt: FIXED_NOW,
    completedAt: FIXED_NOW,
    durationMs: 100,
    routeClosed: 'single-shot-completed',
  };

  const defaultHandle: ReplayRouteHandle = {
    binding: {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
      baseUrl: 'http://127.0.0.1:9999',
      routeToken: 'fake-route-token',
      cliModel: 'target-model',
    },
    get receipt() {
      if (config.receiptShouldReject) {
        return Promise.reject(
          new Error('proxy receipt rejected — no round-trip'),
        );
      }
      return Promise.resolve(config.receipt ?? defaultReceipt);
    },
    async dispose() {
      calls.disposeCalls += 1;
      if (config.disposeShouldThrow) throw new Error('dispose failed');
      return { ok: true, routeClosed: 'disposed-unused' as const };
    },
  };

  const defaultRegisterResult: ReplayRouteRegistration = {
    ok: true,
    handle: defaultHandle,
  };

  const proxy: ReplayProxy = {
    async registerRoute() {
      calls.registerCalls += 1;
      return config.registerResult ?? defaultRegisterResult;
    },
    async shutdown() {
      return { ok: true, routesClosed: 0 };
    },
  };

  return { proxy, calls };
}

// -----------------------------------------------------------------------
// Convenience: build fakes that are consistent with a real sealed bundle
// -----------------------------------------------------------------------

export interface FakeStack {
  readonly bundle: ReplayBundle;
  readonly consent: CliResumeConsent;
  readonly upstream: ReplayUpstreamTarget;
  readonly runtime: ReplayRuntime;
  readonly proxy: ReplayProxy;
  readonly runtimeCalls: FakeRuntimeCallLog;
  readonly proxyCalls: FakeProxyCallLog;
}

/**
 * Build a full fake stack where the fake runtime's observation matches the
 * sealed bundle's hash. This is the normal happy-path setup.
 */
export function createFakeStack(
  runtimeConfig: FakeRuntimeConfig = {},
  proxyConfig: FakeProxyConfig = {},
): FakeStack {
  const bundle = sealedBundle();
  const hash = bundleContentHash(bundle);
  const consent = validConsent(bundle);
  const upstream = fakeUpstream();

  const calls: FakeRuntimeCallLog = {
    prepareCalls: 0,
    executeCalls: 0,
    disposeCalls: 0,
  };

  const observation: ReplayPreparationObservation = {
    sourceCli: 'claude-code' as SourceCli,
    bundleContentHash: hash,
    recordedCliVersion: '1.2.3',
    replayCliVersion: '1.2.3',
    capabilityProfileId: 'claude-code-2.1-headless-resume-v1',
    delivery: {
      schemaVersion: '1.0.0',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
    },
    routeRequirement: {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
    } as ReplayRouteRequirement,
  };

  const prepared: PreparedReplay = {
    observation,
    async execute(_input: ExecutePreparedReplayInput): Promise<ReplayExecutionResult> {
      calls.executeCalls += 1;
      return (
        runtimeConfig.executeResult ?? {
          ok: true,
          observation,
          startedAt: FIXED_NOW,
          completedAt: FIXED_NOW,
          durationMs: 100,
          exitStatus: 0,
        }
      );
    },
    async dispose() {
      calls.disposeCalls += 1;
      if (runtimeConfig.disposeShouldThrow) throw new Error('dispose failed');
      return { ok: true, cleanup: 'complete' as const };
    },
  };

  const runtime: ReplayRuntime = {
    async prepare() {
      calls.prepareCalls += 1;
      return (
        runtimeConfig.prepareResult ?? {
          ok: true,
          prepared,
        }
      );
    },
  };

  const { proxy, calls: proxyCalls } = createFakeProxy(proxyConfig);

  return { bundle, consent, upstream, runtime, proxy, runtimeCalls: calls, proxyCalls };
}
