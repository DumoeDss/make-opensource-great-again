/**
 * @mosga/replay-submit — cli-resume orchestration boundary.
 *
 * Owns the cli-resume submission flow: validates consent against the sealed
 * bundle, drives the locked `prepare → render terminal manifest → register
 * proxy route → execute → dispose` order, and converges the three-hash receipt.
 *
 * Structural no-fallback: this package does NOT import `@mosga/direct-submit`.
 * A package-surface test asserts this. On every failure, `submitCliResume`
 * returns `{ ok: false }` and never retries via a different path.
 */

// Orchestration function + param/result types
export { submitCliResume } from './orchestrate.js';
export type {
  CliResumeSubmitParams,
  CliResumeSubmitResult,
} from './orchestrate.js';

// Terminal-manifest renderer (pure, deterministic)
export { renderTerminalManifest } from './manifest.js';
export type { RenderTerminalManifestInput } from './manifest.js';

// Re-export the consumed contracts so the public surface is self-contained.
export type {
  CliResumeConsent,
  CliResumeReceipt,
  CliResumeSubmitFailure,
  CliResumeSubmitErrorCode,
  CliResumeSubmitStage,
  CliResumeCleanupState,
  CliResumeOutcome,
} from '@mosga/contracts';

// Re-export the consumed runtime / proxy types callers need.
export type {
  ReplayRuntime,
  ReplaySkillRoot,
} from '@mosga/replay-runtime';
export type {
  ReplayProxy,
  ReplayUpstreamTarget,
} from '@mosga/replay-proxy';
