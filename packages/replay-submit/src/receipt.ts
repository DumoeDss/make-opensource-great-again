/**
 * Three-hash receipt assembly.
 *
 * Merges the `ReplayPreparationObservation` (bundle hash, CLI versions,
 * capability profile, delivery target) with the `ReplayProxyReceipt`
 * (CLI-request hash, outbound-request hash, converter, HTTP status, usage,
 * timing) and the accepted consent into one `CliResumeReceipt`.
 *
 * The three hashes originate in separate children and converge here:
 * - `bundleContentHash` — from `ReplayPreparationObservation.bundleContentHash`.
 * - `cliRequestHash` — from `ReplayProxyReceipt.cliRequestHash`.
 * - `outboundRequestHash` — from `ReplayProxyReceipt.outboundRequestHash`.
 */
import type {
  CliResumeConsent,
  CliResumeOutcome,
  CliResumeReceipt,
} from '@mosga/contracts';
import type { ReplayPreparationObservation } from '@mosga/replay-runtime';
import type { ReplayProxyReceipt } from '@mosga/replay-proxy';

/**
 * Assemble the extended receipt from the preparation observation, proxy receipt,
 * and consent. The `runtimeFailed` flag maps the outcome to `'runtime-failed'`
 * when the CLI exited non-zero but the round-trip still completed (the proxy
 * receipt resolved with real hashes + HTTP status).
 */
export function assembleReceipt(
  observation: ReplayPreparationObservation,
  proxyReceipt: ReplayProxyReceipt,
  consent: CliResumeConsent,
  runtimeFailed: boolean,
  now: () => string,
): CliResumeReceipt {
  const outcome: CliResumeOutcome = runtimeFailed
    ? 'runtime-failed'
    : proxyReceipt.outcome;

  return {
    submittedAt: now(),
    sourceCli: observation.sourceCli,
    recordedCliVersion: observation.recordedCliVersion,
    replayCliVersion: observation.replayCliVersion,
    capabilityProfileId: observation.capabilityProfileId,
    targetProviderId: observation.delivery.targetProviderId,
    targetModel: observation.delivery.targetModel,
    upstreamApiFormat: proxyReceipt.upstreamApiFormat,
    converterId: proxyReceipt.converterId,
    converterVersion: proxyReceipt.converterVersion,
    bundleContentHash: observation.bundleContentHash,
    cliRequestHash: proxyReceipt.cliRequestHash,
    outboundRequestHash: proxyReceipt.outboundRequestHash,
    requestCount: proxyReceipt.requestCount,
    httpStatus: proxyReceipt.httpStatus,
    outcome,
    usage: proxyReceipt.usage,
    consent,
    startedAt: proxyReceipt.startedAt,
    completedAt: proxyReceipt.completedAt,
    durationMs: proxyReceipt.durationMs,
  };
}
