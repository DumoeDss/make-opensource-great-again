import { type SanitizedSession, SanitizedSessionSchema } from '@mosga/contracts';

import { type ProvenanceStamp } from './provenance.js';
import { gitleaksVersion, resolveSanitizerPackageVersion } from './version.js';

/** Raised when a session cannot be exported (un-stamped, gate-locked, or invalid). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportOptions {
  /**
   * Installed `@mosga/sanitizer` version to stamp. Defaults to reading the
   * resolved package's `package.json`; injectable for deterministic tests.
   */
  sanitizerPackageVersion?: string;
  /** The gitleaks pin to stamp. Defaults to the sanitizer's `GITLEAKS_VERSION`. */
  gitleaksVersion?: string;
}

/** The in-memory result of exporting one stamped session (no disk write yet). */
export interface ExportedRecord {
  /** The validated, stamped session (unchanged from the input). */
  session: SanitizedSession;
  /** One JSONL line: the stamped envelope (no trailing newline). */
  jsonl: string;
  /** The full file body to write (the JSONL line + a trailing newline). */
  fileContents: string;
  /** Deterministic repo-relative record path (posix separators). */
  recordPath: string;
  /** Deterministic repo-relative provenance sidecar path (posix separators). */
  provenancePath: string;
  /** The machine-readable provenance/version stamp. */
  provenance: ProvenanceStamp;
  /** Number of sessions in this record (always 1: one record per session). */
  recordCount: number;
}

/**
 * Slugify a path component to a filesystem- and git-safe token while staying
 * deterministic (same input → same slug), so re-export is idempotent. Pseudonym
 * aliases like `<USERNAME_1>` contain characters invalid in Windows filenames;
 * this maps any char outside `[A-Za-z0-9._-]` to `-`.
 */
export function slugifyPathComponent(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unknown';
}

/** Placeholder projectKey when there is no cwd to derive a PII-free key from. */
export const REDACTED_PROJECT_KEY = 'redacted-project';

/**
 * Encode a path to a Claude-Code-style project key: every non-alphanumeric char
 * → `-` (mirrors `encodeProjectPath` in `@mosga/session-readers`, no collapsing).
 */
function encodeProjectKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Derive a PII-free `projectKey` for the published record (review finding M1).
 *
 * As readers build the envelope, `session.projectKey` is `encodeProjectPath(cwd)`
 * — the RAW working-directory path (e.g. `-Users-alice-code-proj`), which leaks
 * the contributor's real OS username verbatim and is never scanned/normalized by
 * the sanitizer. Meanwhile `session.cwd` IS scanned and gets pseudonymized. So we
 * re-derive `projectKey` from the (already-sanitized) `cwd` at export, keeping it
 * consistent with `cwd` and carrying no more PII than `cwd` does. When `cwd` is
 * null there is no path to represent → fall back to a fixed non-PII placeholder.
 */
export function publishedProjectKey(session: SanitizedSession): string {
  const cwd = session.session.cwd;
  return cwd && cwd.length > 0 ? encodeProjectKey(cwd) : REDACTED_PROJECT_KEY;
}

/**
 * The deterministic repo-relative path for a session's record:
 * `data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl`. Posix separators
 * so the path is identical across platforms (it is used as a git path).
 */
export function deterministicRecordPath(session: SanitizedSession): string {
  const schema = slugifyPathComponent(session.schemaVersion);
  const alias = slugifyPathComponent(session.meta.contributorAlias);
  const sessionId = slugifyPathComponent(session.session.sessionId);
  return `data/${schema}/${alias}/${sessionId}.jsonl`;
}

/** The provenance sidecar path paired with a record's path. */
export function deterministicProvenancePath(session: SanitizedSession): string {
  return deterministicRecordPath(session).replace(/\.jsonl$/, '.provenance.json');
}

/**
 * Serialize a stamped `SanitizedSession` to the on-disk dataset format: one
 * JSONL record per session, the body structurally isomorphic to the input
 * (no slicing). Refuses an un-stamped, gate-locked, or schema-invalid session.
 */
export function exportSession(session: SanitizedSession, options: ExportOptions = {}): ExportedRecord {
  const parsed = SanitizedSessionSchema.safeParse(session);
  if (!parsed.success) {
    throw new ExportError(`session does not conform to SanitizedSessionSchema: ${parsed.error.message}`);
  }
  const valid = parsed.data;

  if (!valid.meta.sanitized) {
    throw new ExportError(
      'refusing to export an un-sanitized session (meta.sanitized is false); export only a gate-passed, stamped session',
    );
  }
  const rulesetVersion = valid.meta.sanitizationRulesetVersion;
  if (rulesetVersion === null || rulesetVersion.length === 0) {
    throw new ExportError(
      'refusing to export a session with no meta.sanitizationRulesetVersion; it is not stamped by the sanitizer',
    );
  }

  const sanitizerPackageVersion =
    options.sanitizerPackageVersion ?? resolveSanitizerPackageVersion();
  const provenance: ProvenanceStamp = {
    schemaVersion: valid.schemaVersion,
    sanitizationRulesetVersion: rulesetVersion,
    sanitizerPackageVersion,
    gitleaksVersion: options.gitleaksVersion ?? gitleaksVersion,
  };

  // The stamp's ruleset version must equal the envelope's (it is derived from it;
  // assert to make the invariant explicit and catch any future refactor drift).
  if (provenance.sanitizationRulesetVersion !== valid.meta.sanitizationRulesetVersion) {
    throw new ExportError('internal error: provenance ruleset version diverged from the envelope');
  }

  // The bytes we actually publish. The message body stays isomorphic to the input
  // (replay); only `projectKey` is normalized to strip raw PII (finding M1).
  const published: SanitizedSession = {
    ...valid,
    session: { ...valid.session, projectKey: publishedProjectKey(valid) },
  };

  const jsonl = JSON.stringify(published);
  return {
    session: published,
    jsonl,
    fileContents: `${jsonl}\n`,
    recordPath: deterministicRecordPath(published),
    provenancePath: deterministicProvenancePath(published),
    provenance,
    recordCount: 1,
  };
}
