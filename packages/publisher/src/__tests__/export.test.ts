import { SanitizedSessionSchema } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import {
  ExportError,
  REDACTED_PROJECT_KEY,
  deterministicRecordPath,
  exportSession,
} from '../index.js';
import {
  GITLEAKS_PIN,
  RULESET_VERSION,
  SANITIZER_PACKAGE_VERSION,
  cleanSession,
  makeStampedSession,
} from './_fixtures.js';

const OPTS = { sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION };

describe('dataset export', () => {
  it('round-trips losslessly and keeps the message body isomorphic to the input', () => {
    const session = cleanSession();
    const record = exportSession(session, OPTS);

    // One JSONL line = exactly one session.
    expect(record.jsonl.includes('\n')).toBe(false);
    expect(record.recordCount).toBe(1);

    const parsed = JSON.parse(record.jsonl) as unknown;
    // Serialization is lossless: the parsed bytes equal the published record.
    expect(parsed).toEqual(record.session);
    // The message body stays structurally isomorphic to the input (replay).
    expect(record.session.messages).toEqual(session.messages);
    expect(SanitizedSessionSchema.safeParse(parsed).success).toBe(true);
  });

  it('normalizes projectKey from the sanitized cwd, stripping raw PII (M1)', () => {
    // A diligently-reviewed session: cwd pseudonymized to <PATH_1>, but the raw
    // projectKey still encodes the OS username verbatim.
    const session = makeStampedSession([], { cwd: '<PATH_1>', projectKey: '-Users-alice-code-proj' });
    const record = exportSession(session, OPTS);
    expect(record.session.session.projectKey).toBe('-PATH-1-');
    expect(record.session.session.projectKey).not.toContain('alice');
    expect(record.jsonl).not.toContain('alice');
  });

  it('falls back to a non-PII placeholder projectKey when cwd is null', () => {
    const session = makeStampedSession([], { cwd: null, projectKey: '-Users-bob-proj' });
    const record = exportSession(session, OPTS);
    expect(record.session.session.projectKey).toBe(REDACTED_PROJECT_KEY);
    expect(record.jsonl).not.toContain('bob');
  });

  it('refuses an un-stamped session', () => {
    const unstamped = makeStampedSession([], { sanitized: false, sanitizationRulesetVersion: null });
    expect(() => exportSession(unstamped, OPTS)).toThrow(ExportError);
  });

  it('refuses a session with sanitized:true but no ruleset version', () => {
    const noVersion = makeStampedSession([], { sanitized: true, sanitizationRulesetVersion: null });
    expect(() => exportSession(noVersion, OPTS)).toThrow(ExportError);
  });

  it('provenance stamp carries the engine version and matches the envelope', () => {
    const session = cleanSession();
    const record = exportSession(session, OPTS);
    expect(record.provenance).toEqual({
      schemaVersion: '0.1.0',
      sanitizationRulesetVersion: RULESET_VERSION,
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
    // The stamp's ruleset version equals the session's stamped meta value.
    expect(record.provenance.sanitizationRulesetVersion).toBe(
      session.meta.sanitizationRulesetVersion,
    );
  });

  it('resolves a deterministic, idempotent record path', () => {
    const session = makeStampedSession([], { sessionId: 'sess/../weird id', contributorAlias: '<USERNAME_1>' });
    const p1 = exportSession(session, OPTS).recordPath;
    const p2 = exportSession(session, OPTS).recordPath;
    expect(p1).toBe(p2);
    expect(p1).toBe(deterministicRecordPath(session));
    // Path components are slugified to filesystem-safe tokens (no angle brackets/slashes in leaves).
    expect(p1).toMatch(/^data\/0\.1\.0\/USERNAME_1\/[A-Za-z0-9._-]+\.jsonl$/);
  });

  it('reads the real sanitizer package version when not overridden', () => {
    const record = exportSession(cleanSession());
    expect(record.provenance.sanitizerPackageVersion).toBe(SANITIZER_PACKAGE_VERSION);
  });
});
