/**
 * Cli-resume orchestration: the single public entry point that drives the
 * locked `prepare → render → register → execute → dispose` order.
 *
 * The function consumes the three shipped packages' public APIs:
 * - `validateReplayBundle` (replay-bundle) to extract + validate the bundle.
 * - `ReplayRuntime.prepare / execute / dispose` (replay-runtime) to drive the CLI.
 * - `ReplayProxy.registerRoute / handle.receipt / dispose` (replay-proxy) for the
 *   one-shot loopback route.
 *
 * No-fallback guarantee: the function returns `{ ok: false }` on every failure
 * condition and never retries via a different path. It does NOT import
 * `@mosga/direct-submit` — the structural separation is enforced at the
 * package-graph level.
 */
import type {
  CliResumeConsent,
  CliResumeReceipt,
  CliResumeCleanupState,
  CliResumeSubmitErrorCode,
  CliResumeSubmitFailure,
  CliResumeSubmitStage,
  SourceCli,
} from '@mosga/contracts';
import type {
  PreparedReplay,
  ReplayPreparationObservation,
  ReplayRuntime,
  ReplaySkillRoot,
} from '@mosga/replay-runtime';
import type {
  ReplayProxy,
  ReplayProxyReceipt,
  ReplayRouteHandle,
  ReplayUpstreamTarget,
} from '@mosga/replay-proxy';

import { extractValidatedBundle } from './bundleExtract.js';
import { renderTerminalManifest } from './manifest.js';
import { assembleReceipt } from './receipt.js';

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

export interface CliResumeSubmitParams {
  readonly bundle: unknown;
  readonly consent: CliResumeConsent;
  readonly upstream: ReplayUpstreamTarget;
  readonly skillRoots?: readonly ReplaySkillRoot[];
  readonly runtime: ReplayRuntime;
  readonly proxy: ReplayProxy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Timestamp factory for the receipt's `submittedAt`. Defaults to ISO now. */
  readonly now?: () => string;
}

export type CliResumeSubmitResult =
  | { readonly ok: true; readonly receipt: CliResumeReceipt }
  | { readonly ok: false; readonly error: CliResumeSubmitFailure };

// -----------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------

/**
 * Drive the cli-resume submission. See class docs for the locked order.
 *
 * On every exit path, `prepared.dispose()` and `handle.dispose()` are called
 * idempotently. A failure result carries the cleanup state so the caller can
 * report whether disposal completed.
 */
export async function submitCliResume(
  params: CliResumeSubmitParams,
): Promise<CliResumeSubmitResult> {
  const { bundle, consent, upstream, skillRoots, runtime, proxy, timeoutMs, signal } = params;
  const now = params.now ?? (() => new Date().toISOString());

  let prepared: PreparedReplay | null = null;
  let handle: ReplayRouteHandle | null = null;

  /**
   * Run idempotent disposal of both the prepared replay and the proxy route.
   * Returns the cleanup states for the failure result.
   */
  const runCleanup = async (): Promise<
    [CliResumeCleanupState, CliResumeCleanupState]
  > => {
    let runtimeCleanup: CliResumeCleanupState = 'not-started';
    let proxyCleanup: CliResumeCleanupState = 'not-started';
    if (prepared) {
      try {
        await prepared.dispose();
        runtimeCleanup = 'complete';
      } catch {
        runtimeCleanup = 'failed';
      }
    }
    if (handle) {
      try {
        await handle.dispose();
        proxyCleanup = 'complete';
      } catch {
        proxyCleanup = 'failed';
      }
    }
    return [runtimeCleanup, proxyCleanup];
  };

  /**
   * Construct a failure result after running cleanup.
   */
  const fail = async (
    code: CliResumeSubmitErrorCode,
    stage: CliResumeSubmitStage,
    info: {
      sourceCli?: SourceCli | null;
      replayCliVersion?: string | null;
      capabilityProfileId?: string | null;
    } = {},
  ): Promise<CliResumeSubmitResult> => {
    const [runtimeCleanup, proxyCleanup] = await runCleanup();
    return {
      ok: false,
      error: {
        code,
        sourceCli: info.sourceCli ?? null,
        replayCliVersion: info.replayCliVersion ?? null,
        capabilityProfileId: info.capabilityProfileId ?? null,
        stage,
        runtimeCleanup,
        proxyCleanup,
      },
    };
  };

  try {
    // -- Pre-flight: check abort signal --------------------------------
    if (signal?.aborted) {
      return fail('cancelled', 'consent');
    }

    // -- Step 1: Extract + validate bundle + consent (no side effects) -
    const extraction = extractValidatedBundle(bundle, consent);
    if (!extraction.ok) {
      if (extraction.bundleErrorCode) {
        return fail('bundle-invalid', 'bundle');
      }
      return fail('consent-invalid', 'consent');
    }
    const { payload, bundleContentHash } = extraction.extracted;

    // -- Step 2: Prepare runtime (CLI probe + workspace) ---------------
    const prepareResult = await runtime.prepare({
      bundle,
      skillRoots: skillRoots as ReplaySkillRoot[] | undefined,
      signal,
    });
    if (!prepareResult.ok) {
      const code = mapRuntimePrepareFailure(prepareResult.error.code);
      return fail(code, 'prepare', {
        sourceCli: prepareResult.error.sourceCli,
        replayCliVersion: prepareResult.error.replayCliVersion,
      });
    }
    prepared = prepareResult.prepared;
    const observation: ReplayPreparationObservation = prepared.observation;

    // -- Step 3: Verify hash identity (defense-in-depth) ---------------
    if (observation.bundleContentHash !== bundleContentHash) {
      return fail('orchestration-internal-error', 'prepare', {
        sourceCli: observation.sourceCli,
        replayCliVersion: observation.replayCliVersion,
        capabilityProfileId: observation.capabilityProfileId,
      });
    }

    // -- Step 4: Render terminal manifest ------------------------------
    const terminalInput = renderTerminalManifest({
      seed: payload.terminalManifestSeed,
      omissions: payload.omissions,
      humanReviewPassed: payload.review.humanReviewPassed,
      bundleContentHash,
      replayCliVersion: observation.replayCliVersion,
      consent,
    });

    // -- Step 5: Register proxy route ----------------------------------
    const registration = await proxy.registerRoute(
      observation.routeRequirement,
      upstream,
    );
    if (!registration.ok) {
      return fail('proxy-failed', 'register', {
        sourceCli: observation.sourceCli,
        replayCliVersion: observation.replayCliVersion,
        capabilityProfileId: observation.capabilityProfileId,
      });
    }
    handle = registration.handle;

    // -- Step 6: Execute (drive the source CLI) ------------------------
    const executionResult = await prepared.execute({
      terminalInput,
      route: handle.binding,
      timeoutMs,
      signal,
    });

    // -- Step 7: Await proxy receipt -----------------------------------
    let proxyReceipt: ReplayProxyReceipt | null = null;
    try {
      proxyReceipt = await handle.receipt;
    } catch {
      // Receipt rejected — no round-trip completed.
      proxyReceipt = null;
    }

    // -- Step 8: Determine result --------------------------------------
    if (proxyReceipt) {
      // Round-trip completed — assemble and return the receipt. Even if the
      // runtime failed (CLI exited non-zero after sending), the audit trail
      // (hashes + HTTP status) is valid and returned.
      const receipt = assembleReceipt(
        observation,
        proxyReceipt,
        consent,
        !executionResult.ok,
        now,
      );
      await runCleanup();
      return { ok: true, receipt };
    }

    // No round-trip — return a failure.
    if (!executionResult.ok) {
      const code = mapRuntimeExecuteFailure(executionResult.error.code);
      return fail(code, 'execute', {
        sourceCli: executionResult.error.sourceCli,
        replayCliVersion: executionResult.error.replayCliVersion,
      });
    }

    // Execute succeeded but no receipt — the proxy round-trip never completed.
    return fail('proxy-failed', 'receipt', {
      sourceCli: observation.sourceCli,
      replayCliVersion: observation.replayCliVersion,
      capabilityProfileId: observation.capabilityProfileId,
    });
  } catch (error) {
    // Unexpected error — clean up and return a generic failure. Log server-side
    // only; the public failure carries no raw cause.
    console.error('[submitCliResume] unexpected error:', error);
    return fail('orchestration-internal-error', 'execute');
  }
}

// -----------------------------------------------------------------------
// Failure-code mapping
// -----------------------------------------------------------------------

/**
 * Map a runtime prepare failure code to the orchestration error code.
 * Unsupported version/capability → `runtime-unsupported`; everything else →
 * `runtime-failed`.
 */
function mapRuntimePrepareFailure(
  code: string,
): CliResumeSubmitErrorCode {
  if (code === 'cli-version-unsupported' || code === 'cli-capability-unsupported') {
    return 'runtime-unsupported';
  }
  return 'runtime-failed';
}

/**
 * Map a runtime execute failure code to the orchestration error code.
 * Cancellation and timeout have their own codes; unsupported (unlikely during
 * execute, but handled defensively) → `runtime-unsupported`; everything else →
 * `runtime-failed`.
 */
function mapRuntimeExecuteFailure(
  code: string,
): CliResumeSubmitErrorCode {
  if (code === 'cancelled') return 'cancelled';
  if (code === 'timed-out') return 'timed-out';
  if (code === 'cli-version-unsupported' || code === 'cli-capability-unsupported') {
    return 'runtime-unsupported';
  }
  return 'runtime-failed';
}
