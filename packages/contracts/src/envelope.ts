import { z } from 'zod';

import { ParsedMessageSchema } from './message.js';

/**
 * Known `meta.sourceCli` values. Extensible by APPENDING (design D7): adding a
 * value (e.g. `"codex"`, `"cursor"`) widens the accepted set — a non-breaking,
 * additive change for consumers. v0.1 ships only `claude-code`.
 */
export const SOURCE_CLI_VALUES = ['claude-code'] as const;
export const SourceCliSchema = z.enum(SOURCE_CLI_VALUES);
export type SourceCli = z.infer<typeof SourceCliSchema>;

/**
 * Top-level provenance/sanitization metadata. Readers emit `sanitized:false` and
 * `sanitizationRulesetVersion:null`; the sanitizer (slice 2) stamps them.
 */
export const SanitizedSessionMetaSchema = z.object({
  contributorAlias: z.string(),
  sourceCli: SourceCliSchema,
  toolVersion: z.string(),
  sanitizationRulesetVersion: z.string().nullable(),
  exportedAt: z.string(),
  license: z.string().nullable(),
  sanitized: z.boolean(),
});
export type SanitizedSessionMeta = z.infer<typeof SanitizedSessionMetaSchema>;

/**
 * Session identity + raw metadata. `cwd` is raw out of readers; slice 2
 * normalizes/aliases it.
 */
export const SanitizedSessionInfoSchema = z.object({
  sessionId: z.string(),
  sourceId: z.string(),
  projectKey: z.string(),
  cwd: z.string().nullable(),
  title: z.string().nullable(),
  updatedAt: z.number(),
});
export type SanitizedSessionInfo = z.infer<typeof SanitizedSessionInfoSchema>;

/**
 * The v0.1 sanitized-session intermediate envelope (design D7) — the shared
 * format every slice aligns to. `messages` is kept structurally isomorphic to
 * the source Claude Code JSONL so 出口② replay remains possible; dataset slicing
 * is deferred to the export layer (slice 4). `schemaVersion` is the load-bearing
 * version knob for coordinated future bumps.
 */
export const SanitizedSessionSchema = z.object({
  schemaVersion: z.string(),
  meta: SanitizedSessionMetaSchema,
  session: SanitizedSessionInfoSchema,
  messages: z.array(ParsedMessageSchema),
});
export type SanitizedSession = z.infer<typeof SanitizedSessionSchema>;
