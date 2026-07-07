import { z } from 'zod';

/**
 * The provenance/version stamp emitted alongside every exported record. It pins
 * the *engine* (`sanitizerPackageVersion`), not just the rule text
 * (`sanitizationRulesetVersion`) — so the community CI can install the exact
 * matching `@mosga/sanitizer` version and its re-scan is byte-identical to the
 * local pre-check (sanitizer review m3 resolution; design D3).
 */
export const ProvenanceStampSchema = z.object({
  /** The exported session's `schemaVersion` (dataset layout knob). */
  schemaVersion: z.string(),
  /** The ruleset version the session was sanitized under (from `meta`). */
  sanitizationRulesetVersion: z.string(),
  /** Installed `@mosga/sanitizer` version — CI pins this exact version. */
  sanitizerPackageVersion: z.string(),
  /** The gitleaks pin the vendored ruleset came from. */
  gitleaksVersion: z.string(),
});
export type ProvenanceStamp = z.infer<typeof ProvenanceStampSchema>;

/**
 * The engine identity the local pre-check ran under, surfaced for CI parity: the
 * community CI pins `sanitizerPackageVersion` and its re-scan must reproduce
 * `rulesetVersion` (and `gitleaksVersion`) exactly, else the divergence is a
 * visible CI failure rather than a silent gap.
 */
export interface EngineInfo {
  sanitizerPackageVersion: string;
  rulesetVersion: string;
  gitleaksVersion: string;
}
