/**
 * Cli-resume consent, receipt, and failure contracts.
 *
 * These schemas are ADDITIVE — the existing `ContributionConsentSchema` /
 * `SubmissionReceiptSchema` (which bind the `single-shot` / `turn-by-turn`
 * reconstructed-API path) remain unchanged. A separate consent shape keeps each
 * path self-consistent: cli-resume binds the validated bundle content hash
 * (`sha256:<lowercase-hex>`), the `cli-resume` replay mode, instruction/skill
 * policy, and a new `runtimeContextAcknowledged` flag that has no meaning under
 * the reconstructed-API path.
 */
import { z } from 'zod';

import { SourceCliSchema } from './envelope.js';
import { ReplayDigestSchema } from './replay.js';
import { SubmissionUsageSchema } from './contribution.js';

// -----------------------------------------------------------------------
// API format — mirrors `@mosga/replay-proxy`'s `ReplayApiFormat`. Defined here
// (contracts) so the receipt schema is self-contained without importing the
// proxy package. The values are structurally identical to the proxy's type.
// -----------------------------------------------------------------------

export const CliResumeApiFormatSchema = z.enum([
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
]);
export type CliResumeApiFormat = z.infer<typeof CliResumeApiFormatSchema>;

// -----------------------------------------------------------------------
// Consent
// -----------------------------------------------------------------------

/**
 * Informed-consent record required before a cli-resume submission. Binds the
 * validated bundle content hash (not the legacy session hash), target provider
 * + model, the `cli-resume` replay mode, the fixed v1 instruction/skill policy,
 * and a `runtimeContextAcknowledged` flag disclosing that the source CLI
 * dynamically assembles its own system prompt, tool definitions, environment
 * context, and discovered skill descriptions that are NOT rescanned by the
 * proxy. All three acknowledgments MUST be true.
 */
export const CliResumeConsentSchema = z.object({
  consentVersion: z.string().min(1),
  tosRiskAcknowledged: z.boolean(),
  fullRetentionAcknowledged: z.boolean(),
  runtimeContextAcknowledged: z.boolean(),
  bundleContentHash: ReplayDigestSchema,
  targetProviderId: z.string().min(1),
  targetModel: z.string().min(1),
  replayMode: z.literal('cli-resume'),
  instructionPolicy: z.literal('sanitized-snapshot'),
  skillPolicy: z.literal('cli-discovery-read-only'),
  confirmedAt: z.string().datetime({ offset: true }),
});
export type CliResumeConsent = z.infer<typeof CliResumeConsentSchema>;

// -----------------------------------------------------------------------
// Receipt
// -----------------------------------------------------------------------

/**
 * Receipt outcome for a cli-resume round-trip. `runtime-failed` records the
 * case where the CLI sent the request successfully (the proxy receipt resolved
 * with real hashes + HTTP status) but exited non-zero.
 */
export const CliResumeOutcomeSchema = z.enum([
  'inference-served',
  'upstream-non-2xx',
  'upstream-request-failed',
  'runtime-failed',
]);
export type CliResumeOutcome = z.infer<typeof CliResumeOutcomeSchema>;

/**
 * Extended receipt converging all three hashes:
 * - `bundleContentHash` — from the runtime preparation observation.
 * - `cliRequestHash` — from the proxy receipt (the CLI's outbound body).
 * - `outboundRequestHash` — from the proxy receipt (after protocol conversion).
 *
 * NEVER includes the real API key, route token, full request/response bodies,
 * system prompts, tool schemas, the workspace path, or CLI-generated content.
 */
export const CliResumeReceiptSchema = z.object({
  submittedAt: z.string(),
  sourceCli: SourceCliSchema,
  recordedCliVersion: z.string().nullable(),
  replayCliVersion: z.string(),
  capabilityProfileId: z.string(),
  targetProviderId: z.string(),
  targetModel: z.string(),
  upstreamApiFormat: CliResumeApiFormatSchema,
  converterId: z.string(),
  converterVersion: z.string(),
  bundleContentHash: ReplayDigestSchema,
  cliRequestHash: ReplayDigestSchema,
  outboundRequestHash: ReplayDigestSchema,
  requestCount: z.number(),
  httpStatus: z.number(),
  outcome: CliResumeOutcomeSchema,
  usage: SubmissionUsageSchema.nullable(),
  consent: CliResumeConsentSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
});
export type CliResumeReceipt = z.infer<typeof CliResumeReceiptSchema>;

// -----------------------------------------------------------------------
// Orchestration failure
// -----------------------------------------------------------------------

/**
 * Closed v1 failure-code set. Every public cli-resume orchestration failure
 * carries one of these codes. No code leaks the route token, the real API key,
 * full request or response bodies, system prompts, tool schemas, provider error
 * bodies, the workspace path, or any CLI-generated content.
 */
export const CliResumeSubmitErrorCodeSchema = z.enum([
  'consent-invalid',
  'bundle-invalid',
  'runtime-unsupported',
  'runtime-failed',
  'proxy-failed',
  'upstream-failed',
  'cancelled',
  'timed-out',
  'orchestration-internal-error',
]);
export type CliResumeSubmitErrorCode = z.infer<
  typeof CliResumeSubmitErrorCodeSchema
>;

/**
 * The orchestration pipeline stage at which a failure was classified.
 */
export const CliResumeSubmitStageSchema = z.enum([
  'consent',
  'bundle',
  'prepare',
  'render',
  'register',
  'execute',
  'receipt',
  'dispose',
]);
export type CliResumeSubmitStage = z.infer<typeof CliResumeSubmitStageSchema>;

/**
 * Cleanup disposal state reported in a failure result.
 */
export const CliResumeCleanupStateSchema = z.enum([
  'not-started',
  'complete',
  'failed',
]);
export type CliResumeCleanupState = z.infer<
  typeof CliResumeCleanupStateSchema
>;

/**
 * The only shape a public cli-resume orchestration failure takes. Contains
 * nothing but stable identifiers — never a raw cause, key, token, body, or path.
 */
export const CliResumeSubmitFailureSchema = z.object({
  code: CliResumeSubmitErrorCodeSchema,
  sourceCli: SourceCliSchema.nullable(),
  replayCliVersion: z.string().nullable(),
  capabilityProfileId: z.string().nullable(),
  stage: CliResumeSubmitStageSchema,
  runtimeCleanup: CliResumeCleanupStateSchema,
  proxyCleanup: CliResumeCleanupStateSchema,
});
export type CliResumeSubmitFailure = z.infer<
  typeof CliResumeSubmitFailureSchema
>;
