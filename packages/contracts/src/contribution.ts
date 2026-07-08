import { z } from 'zod';

/**
 * 出口② replay cost profile. `single-shot` POSTs the whole conversation plus the
 * meta message in one request (linear in turn count — the default); `turn-by-turn`
 * re-generates each assistant turn from its prefix (quadratic — opt-in, see the
 * change design's measured cost table).
 */
export const ReplayModeSchema = z.enum(['single-shot', 'turn-by-turn']);
export type ReplayMode = z.infer<typeof ReplayModeSchema>;

/**
 * Informed-consent record required before a direct-submit send. It is bound to
 * the exact stamped content by `contentHash` (sha256 of the canonicalized
 * `SanitizedSession`): the submitter recomputes the hash and refuses when consent
 * is absent, either acknowledgment is false, or the hash mismatches. Both
 * acknowledgments MUST be true. No API key material is part of this record — the
 * contributor's key is read server-side and never enters consent, meta, receipt,
 * or any daemon response.
 */
export const ContributionConsentSchema = z.object({
  consentVersion: z.string(),
  /** User saw and accepted the provider-ToS-risk disclosure. Must be true. */
  tosRiskAcknowledged: z.boolean(),
  /** User understands the full session (incl. assistant messages) is sent. Must be true. */
  fullRetentionAcknowledged: z.boolean(),
  targetProviderId: z.string(),
  targetModel: z.string(),
  replayMode: ReplayModeSchema,
  /** The token estimate the user was shown at confirm time. */
  estimatedTokens: z.number(),
  /** sha256 of the canonicalized stamped session — binds consent to exact content. */
  contentHash: z.string(),
  confirmedAt: z.string(),
});
export type ContributionConsent = z.infer<typeof ContributionConsentSchema>;

/**
 * The consent acknowledgment echoed inside the meta message (a human- and
 * pipeline-readable subset of the full consent record — never key material).
 */
export const ContributionConsentAckSchema = z.object({
  consentVersion: z.string(),
  tosRiskAcknowledged: z.boolean(),
  fullRetentionAcknowledged: z.boolean(),
  confirmedAt: z.string(),
});
export type ContributionConsentAck = z.infer<typeof ContributionConsentAckSchema>;

/**
 * Contribution provenance payload attached as the terminal turn of the replay.
 * Serialized deterministically into the turn text so both a human and a provider
 * pipeline can parse it. It is part of the outbound bytes, so the pre-send
 * backstop scans it too. Carries provenance + a consent acknowledgment + a
 * human-readable disclosure — and NO API key.
 */
export const ContributionMetaSchema = z.object({
  kind: z.literal('mosga-contribution-meta'),
  metaVersion: z.string(),
  toolVersion: z.string(),
  sanitizationRulesetVersion: z.string().nullable(),
  sanitizerPackageVersion: z.string(),
  contributorAlias: z.string(),
  license: z.string().nullable(),
  sourceCli: z.string(),
  sessionId: z.string(),
  consent: ContributionConsentAckSchema,
  /** Human-readable disclosure (sanitized community contribution; non-text media absent). */
  note: z.string(),
});
export type ContributionMeta = z.infer<typeof ContributionMetaSchema>;

/**
 * Token usage captured from the provider response, normalized across
 * Anthropic (`input_tokens`/`output_tokens`) and OpenAI
 * (`prompt_tokens`/`completion_tokens`) shapes.
 */
export const SubmissionUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type SubmissionUsage = z.infer<typeof SubmissionUsageSchema>;

/**
 * Key-free receipt of a completed direct-submit. Records what was sent, the
 * accepted consent, the content hash, and that the pre-send backstop passed.
 * Contains no API key by construction.
 */
export const SubmissionReceiptSchema = z.object({
  submittedAt: z.string(),
  targetProviderId: z.string(),
  targetModel: z.string(),
  replayMode: ReplayModeSchema,
  /** 1 for single-shot; the number of prefix requests for turn-by-turn. */
  requestCount: z.number(),
  usage: SubmissionUsageSchema.nullable(),
  contentHash: z.string(),
  consent: ContributionConsentSchema,
  /** Always true on a returned receipt — a failing backstop throws instead. */
  backstopPassed: z.literal(true),
  /** HTTP status of the (last) provider response. */
  providerStatus: z.number(),
});
export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;
