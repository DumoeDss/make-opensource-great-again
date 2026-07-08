import { describe, expect, it } from 'vitest';

import { applyDispositions, setDispositions } from '../apply.js';
import { compileRuleset } from '../ingest.js';
import type { CompiledRuleset, Finding, FindingField } from '../schemas.js';
import { collectScanUnits, scanSession } from '../scan.js';
import { FAKE_GITHUB_PAT, makeMessage, makeSession } from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

let ruleset: CompiledRuleset;
function rs(): CompiledRuleset {
  if (!ruleset) ruleset = compileRuleset({ generatedAt: AT });
  return ruleset;
}

/** The one blocking, non-guard secret finding, if any. */
function secretFinding(findings: Finding[]): Finding | undefined {
  return findings.find((f) => f.layer === 'secrets' && f.ruleId !== 'redos-guard');
}

describe('envelope-field scan coverage (mosga-v02)', () => {
  it('finds a planted secret in session.projectKey and locks the gate (5.1)', () => {
    const session = makeSession([], { projectKey: `proj-${FAKE_GITHUB_PAT}` });
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const secret = secretFinding(report.findings);
    expect(secret).toBeDefined();
    expect(secret!.blocking).toBe(true);
    expect(secret!.location.field).toBe('sessionProjectKey');
    expect(report.gate.blockingPending).toBeGreaterThan(0);
  });

  it('finds a planted secret in every newly covered string field (5.2)', () => {
    // Each entry plants the same obviously-fake PAT in one field and asserts a
    // blocking finding lands at that field's `location.field`.
    const cases: Array<[FindingField, (s: ReturnType<typeof makeSession>) => void]> = [
      ['sessionId', (s) => (s.session.sessionId = FAKE_GITHUB_PAT)],
      ['sessionSourceId', (s) => (s.session.sourceId = FAKE_GITHUB_PAT)],
      ['metaToolVersion', (s) => (s.meta.toolVersion = FAKE_GITHUB_PAT)],
      ['metaContributorAlias', (s) => (s.meta.contributorAlias = FAKE_GITHUB_PAT)],
      ['metaExportedAt', (s) => (s.meta.exportedAt = FAKE_GITHUB_PAT)],
      ['metaLicense', (s) => (s.meta.license = FAKE_GITHUB_PAT)],
      ['schemaVersion', (s) => (s.schemaVersion = FAKE_GITHUB_PAT)],
    ];
    for (const [field, plant] of cases) {
      const session = makeSession([]);
      plant(session);
      const { report } = scanSession(session, rs(), { generatedAt: AT });
      const secret = secretFinding(report.findings);
      expect(secret, `expected a finding for ${field}`).toBeDefined();
      expect(secret!.blocking).toBe(true);
      expect(secret!.location.field).toBe(field);
      expect(report.gate.blockingPending).toBeGreaterThan(0);
    }
  });

  it('skips boolean/null fields and coerces updatedAt to string (5.3)', () => {
    // A clean session: license null, sanitized false (boolean), updatedAt number.
    const session = makeSession([], { updatedAt: 1_700_000_000_123 });
    session.meta.license = null;
    const units = collectScanUnits(session);
    const fields = units.map((u) => u.field);

    // The null field yields no scan unit; the boolean has no FindingField at all.
    expect(fields).not.toContain('metaLicense');
    // updatedAt is scanned via its string coercion.
    const updated = units.find((u) => u.field === 'sessionUpdatedAt');
    expect(updated).toBeDefined();
    expect(updated!.text).toBe('1700000000123');

    // A clean provenance envelope produces no structured (blocking) finding.
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    expect(report.gate.blockingPending).toBe(0);
  });

  it('emits the redos-guard finding for an oversized projectKey (5.4)', () => {
    const session = makeSession([], { projectKey: 'a'.repeat(200_001) });
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const guard = report.findings.find(
      (f) => f.ruleId === 'redos-guard' && f.location.field === 'sessionProjectKey',
    );
    expect(guard).toBeDefined();
    expect(guard!.blocking).toBe(true);
  });
});

describe('encoded projectKey pseudonymization (mosga-v02)', () => {
  it.each([
    ['-Users-alice-acme-secret'],
    ['C--Users-alice-acme-secret'],
  ])('emits a non-blocking path pseudonym for %s (6.1)', (projectKey) => {
    const session = makeSession([], { projectKey });
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const path = report.findings.find(
      (f) => f.category === 'path' && f.location.field === 'sessionProjectKey',
    );
    expect(path).toBeDefined();
    expect(path!.blocking).toBe(false);
    expect(path!.matchPreview).toBe(projectKey);
    expect(path!.replacementSuggestion).toMatch(/^<PATH_\d+>$/);
  });

  it('collapses the same path in cwd and projectKey to one placeholder (6.2)', () => {
    // projectKey is `encodeProjectPath('/Users/alice/acme')` — every
    // non-alphanumeric mapped to `-`.
    const session = makeSession([], {
      cwd: '/Users/alice/acme',
      projectKey: '-Users-alice-acme',
    });
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const cwdPath = report.findings.find(
      (f) => f.category === 'path' && f.location.field === 'sessionCwd',
    );
    const keyPath = report.findings.find(
      (f) => f.category === 'path' && f.location.field === 'sessionProjectKey',
    );
    expect(cwdPath).toBeDefined();
    expect(keyPath).toBeDefined();
    expect(keyPath!.replacementSuggestion).toBe(cwdPath!.replacementSuggestion);
  });

  it('pseudonymizes projectKey on apply, leaving the input unchanged (6.3)', () => {
    const projectKey = '-Users-alice-acme-secret';
    const session = makeSession([], { projectKey });
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setDispositions(
      report,
      (f) => f.category === 'path' && f.location.field === 'sessionProjectKey',
      'replace',
    );
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.session.projectKey).toMatch(/^<PATH_\d+>$/);
    expect(out.session.projectKey).not.toContain('alice');
    // Input session untouched.
    expect(session.session.projectKey).toBe(projectKey);
  });

  it('a replace on a projectKey secret changes the output bytes (6.4)', () => {
    const projectKey = `proj-${FAKE_GITHUB_PAT}`;
    const session = makeSession([], { projectKey });
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setDispositions(
      report,
      (f) => f.layer === 'secrets' && f.location.field === 'sessionProjectKey',
      'replace',
    );
    const { session: out } = applyDispositions(session, updated, mapper);
    // The writer is wired: the raw secret is gone from the output bytes.
    expect(out.session.projectKey).not.toBe(projectKey);
    expect(out.session.projectKey).not.toContain(FAKE_GITHUB_PAT);
  });
});

describe('provenance immutability (mosga-v02)', () => {
  it('passes untouched provenance through byte-identical, only stamping the 3 fields (7.1)', () => {
    const session = makeSession([]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    expect(report.gate.unlocked).toBe(true); // clean → stampable
    const { session: out, stamped } = applyDispositions(session, report, mapper);
    expect(stamped).toBe(true);

    // Untouched provenance is byte-identical.
    expect(out.meta.toolVersion).toBe(session.meta.toolVersion);
    expect(out.meta.exportedAt).toBe(session.meta.exportedAt);
    expect(out.meta.sourceCli).toBe(session.meta.sourceCli);
    expect(out.session.sourceId).toBe(session.session.sourceId);
    expect(out.schemaVersion).toBe(session.schemaVersion);

    // Only the three stamped fields change.
    expect(out.meta.sanitized).toBe(true);
    expect(out.meta.sanitizationRulesetVersion).toBe(report.sanitizationRulesetVersion);
    expect(out.meta.contributorAlias).toBe(mapper.primaryContributorAlias());
  });

  it('stamp overrides any human disposition on the stamped fields (7.2)', () => {
    // A username in a message gives the mapper a real primary alias; a planted
    // secret in contributorAlias, dispositioned replace, must still be
    // overwritten by the authoritative stamp.
    const session = makeSession([makeMessage({ content: 'work in /home/alice/project' })]);
    session.meta.contributorAlias = FAKE_GITHUB_PAT;
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setDispositions(report, (f) => f.blocking, 'replace');
    const { session: out, stamped } = applyDispositions(session, updated, mapper);
    expect(stamped).toBe(true);
    expect(out.meta.contributorAlias).toBe(mapper.primaryContributorAlias());
    expect(out.meta.contributorAlias).toBe('<USER_1>');
    expect(out.meta.sanitizationRulesetVersion).toBe(report.sanitizationRulesetVersion);
  });
});
