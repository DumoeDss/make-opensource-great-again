import { z } from 'zod';

/**
 * Rule + report + artifact schemas for `@mosga/sanitizer` (design D7).
 *
 * These are the cross-slice contract: slices 3 (review UI) and 4 (publisher/CI)
 * consume them. Slices 3/4 import the *types* with `import type` (erased at
 * runtime, zero pull-in); slice 4's CI additionally imports the engine to
 * re-run the scan. Per design D1 they live here rather than `@mosga/contracts`
 * because readers is not yet archived (no `session-contracts` capability to file
 * a MODIFIED delta against) and the lead scoped everything under this package.
 */

// ---------------------------------------------------------------------------
// Rule model (task 2.1)
// ---------------------------------------------------------------------------

/**
 * Terminal translation state of a gitleaks rule after RE2→JS ingestion.
 * `native`: pattern used verbatim. `translated`: transformed but behavior-
 * preserving for matching. `degraded`: no faithful RegExp — fell back to a
 * case-insensitive keyword/literal matcher. `disabled`: untranslatable and no
 * usable keywords — carries a reason, matches nothing. Every rule ends in
 * exactly one of these (design-doc "no silent truncation").
 */
export const TranslationStatusSchema = z.enum([
  'native',
  'translated',
  'degraded',
  'disabled',
]);
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;

/**
 * A gitleaks/global allowlist as it applies to in-memory session scanning.
 * `regexes` + `stopwords` suppress known example secrets; `paths`/`commits` are
 * inapplicable to session scanning and are dropped with a documented note
 * (design D4) rather than silently.
 */
export const RuleAllowlistSchema = z.object({
  description: z.string().optional(),
  regexes: z.array(z.string()).default([]),
  stopwords: z.array(z.string()).default([]),
  /** Whether allowlist matching targets the whole match or the secretGroup. */
  regexTarget: z.enum(['match', 'line', 'secret']).optional(),
});
export type RuleAllowlist = z.infer<typeof RuleAllowlistSchema>;

/** A normalized, scan-ready gitleaks rule (L1). */
export const NormalizedRuleSchema = z.object({
  id: z.string(),
  description: z.string().default(''),
  /** JS-`RegExp`-source translated from the rule's Go RE2 pattern. */
  regexSource: z.string(),
  flags: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  entropy: z.number().optional(),
  secretGroup: z.number().optional(),
  allowlist: RuleAllowlistSchema.optional(),
  translation: z.object({
    status: TranslationStatusSchema,
    notes: z.string().default(''),
  }),
});
export type NormalizedRule = z.infer<typeof NormalizedRuleSchema>;

/** A user custom rule (L2). Literal entries are matched exactly (escaped). */
export const CustomRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  kind: z.enum(['regex', 'literal']),
  pattern: z.string(),
  replacement: z.string().optional(),
});
export type CustomRule = z.infer<typeof CustomRuleSchema>;

// ---------------------------------------------------------------------------
// Compiled ruleset artifact (task 2.3)
// ---------------------------------------------------------------------------

export const DegradedEntrySchema = z.object({
  id: z.string(),
  status: TranslationStatusSchema,
  reason: z.string(),
});
export type DegradedEntry = z.infer<typeof DegradedEntrySchema>;

/**
 * The compiled ruleset artifact both the tool and slice-4 CI load, so local
 * pre-check and CI re-check run the identical rule set. `rulesetVersion` is a
 * composite id (`gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>`) stamped into the
 * report and the sanitized envelope for parity checks.
 */
export const CompiledRulesetSchema = z.object({
  rulesetVersion: z.string(),
  gitleaksVersion: z.string(),
  generatedAt: z.string(),
  rules: z.array(NormalizedRuleSchema),
  customRules: z.array(CustomRuleSchema).default([]),
  /** Global `[allowlist]` from the gitleaks config, applied to every rule. */
  globalAllowlist: RuleAllowlistSchema.optional(),
  degraded: z.array(DegradedEntrySchema),
});
export type CompiledRuleset = z.infer<typeof CompiledRulesetSchema>;

// ---------------------------------------------------------------------------
// Findings / report model (task 2.2, design D7)
// ---------------------------------------------------------------------------

/** L1 secrets | L2 custom | L3 normalization. */
export const LayerSchema = z.enum(['secrets', 'custom', 'normalization']);
export type Layer = z.infer<typeof LayerSchema>;

/** Per-finding disposition. Default `pending` (unresolved). */
export const DispositionSchema = z.enum(['pending', 'replace', 'delete', 'allow']);
export type Disposition = z.infer<typeof DispositionSchema>;

/** L3 normalization categories. */
export const NormalizationCategorySchema = z.enum([
  'path',
  'username',
  'email',
  'ipv4',
  'ipv6',
]);
export type NormalizationCategory = z.infer<typeof NormalizationCategorySchema>;

/** A scannable string-bearing field within the session structure (design D5). */
export const FindingFieldSchema = z.enum([
  'content',
  'thinking',
  'commandName',
  'commandMessage',
  'commandArgs',
  'toolCallInput',
  'toolCallResult',
  'toolResultContent',
  'sessionCwd',
  'sessionTitle',
  // Session-level identity + provenance envelope fields (all scope:'session',
  // non-message). Widened coverage so a secret planted in any string-bearing
  // envelope position becomes a gating finding the human review gate can see,
  // matching the publisher's raw-bytes backstop. `sessionUpdatedAt` is a number
  // coerced to string for scanning only (block-only, no apply writer).
  'schemaVersion',
  'metaContributorAlias',
  'metaSourceCli',
  'metaToolVersion',
  'metaExportedAt',
  'metaLicense',
  'sessionId',
  'sessionSourceId',
  'sessionProjectKey',
  'sessionUpdatedAt',
  // Session-level, non-span marker for engine/ruleset warnings (e.g. a rule that
  // failed to compile on the consumer runtime). Not a text position — apply
  // ignores it — but it lets such a warning surface as a gating finding instead
  // of vanishing (no-silent-drop at the tool/CI boundary).
  'rulesetMeta',
]);
export type FindingField = z.infer<typeof FindingFieldSchema>;

export const FindingLocationSchema = z.object({
  scope: z.enum(['message', 'session']),
  /** Index into `SanitizedSession.messages` (scope=message). */
  messageIndex: z.number().optional(),
  /** `ParsedMessage.sdkUuid` — stable across re-scans. */
  messageUuid: z.string().optional(),
  field: FindingFieldSchema,
  /** Present for field = toolCallInput | toolCallResult. */
  toolCallId: z.string().optional(),
  /** Present for field = toolResultContent. */
  toolResultIndex: z.number().optional(),
  /** Char offsets into the RESOLVED field string. */
  span: z.object({ start: z.number(), end: z.number() }),
});
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

export const FindingSchema = z.object({
  /** Stable hash of (location + ruleId) — disposition key across re-scans. */
  id: z.string(),
  layer: LayerSchema,
  /** gitleaks rule id | custom rule id | L3 category id. */
  ruleId: z.string(),
  category: NormalizationCategorySchema.optional(),
  location: FindingLocationSchema,
  /** SAFE-to-display preview; secrets/custom are redacted (never the raw secret). */
  matchPreview: z.string(),
  replacementSuggestion: z.string(),
  disposition: DispositionSchema.default('pending'),
  /** true for secrets + custom (block-on-hit); false for normalization. */
  blocking: z.boolean(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const NonTextItemSchema = z.object({
  messageIndex: z.number(),
  messageUuid: z.string(),
  /** From `ParsedMessage.nonTextContent` (may sit on a tool_use message). */
  blockTypes: z.array(z.string()),
  disposition: z.enum(['pending', 'keep', 'remove']).default('pending'),
});
export type NonTextItem = z.infer<typeof NonTextItemSchema>;

export const SanitizationReportSchema = z.object({
  reportVersion: z.string(),
  /** == compiled ruleset composite version. */
  sanitizationRulesetVersion: z.string(),
  sessionId: z.string(),
  generatedAt: z.string(),
  findings: z.array(FindingSchema),
  layerSummary: z.object({
    secrets: z.object({ total: z.number(), pending: z.number() }),
    custom: z.object({ total: z.number(), pending: z.number() }),
    normalization: z.object({
      total: z.number(),
      byCategory: z.record(z.string(), z.number()),
    }),
  }),
  nonTextItems: z.array(NonTextItemSchema),
  gate: z.object({
    blockingTotal: z.number(),
    blockingPending: z.number(),
    nonTextPending: z.number(),
    unlocked: z.boolean(),
  }),
});
export type SanitizationReport = z.infer<typeof SanitizationReportSchema>;
