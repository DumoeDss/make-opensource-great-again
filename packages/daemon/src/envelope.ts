/**
 * Build the `SanitizedSession` envelope readers hand to the sanitizer: parse the
 * transcript (carrying `nonTextContent` markers), fill provisional `meta`
 * (`sanitized:false`, ruleset version null — the sanitizer stamps them at
 * export), and copy identity from the session ref.
 */
import type { CliSessionRef, ParsedMessage, SanitizedSession } from '@mosga/contracts';

/** Tool version stamped into `meta.toolVersion`; the daemon package version. */
export const TOOL_VERSION = '0.1.0';

/** The envelope `schemaVersion` matches the readers' v0.1 intermediate format. */
export const SCHEMA_VERSION = '0.1.0';

export function buildEnvelope(
  ref: CliSessionRef,
  messages: ParsedMessage[],
  options: { exportedAt?: string } = {},
): SanitizedSession {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      // Provisional; the pseudonym mapper fills the real alias at export.
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: TOOL_VERSION,
      sanitizationRulesetVersion: null,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      license: null,
      sanitized: false,
    },
    session: {
      sessionId: ref.id,
      sourceId: ref.sourceId,
      projectKey: ref.projectKey,
      cwd: ref.cwd,
      title: ref.title,
      updatedAt: ref.updatedAt,
    },
    messages,
  };
}
