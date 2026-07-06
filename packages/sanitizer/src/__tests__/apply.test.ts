import { SanitizedSessionSchema } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyDispositions,
  batchByRule,
  batchByType,
  setDispositions,
  setNonTextDisposition,
} from '../apply.js';
import { compileRuleset } from '../ingest.js';
import type { CompiledRuleset } from '../schemas.js';
import { scanSession } from '../scan.js';
import { FAKE_GITHUB_PAT, makeMessage, makeSession } from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

let ruleset: CompiledRuleset;
function rs(): CompiledRuleset {
  if (!ruleset) ruleset = compileRuleset({ generatedAt: AT });
  return ruleset;
}

describe('per-hit application', () => {
  it('replace substitutes the placeholder and leaves the input session unchanged', () => {
    const original = 'email me at dev@example.com please';
    const session = makeSession([makeMessage({ content: original })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByType(report, 'email', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);

    expect(out.messages[0].content).not.toContain('dev@example.com');
    expect(out.messages[0].content).toMatch(/<EMAIL_1>/);
    // Input session untouched (no in-place mutation).
    expect(session.messages[0].content).toBe(original);
  });

  it('allow leaves the matched text intact', () => {
    const original = 'email me at dev@example.com please';
    const session = makeSession([makeMessage({ content: original })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByType(report, 'email', 'allow');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.messages[0].content).toBe(original);
  });

  it('applies two non-overlapping hits in one string correctly', () => {
    const original = 'reach a@x.com or b@y.com';
    const session = makeSession([makeMessage({ content: original })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByType(report, 'email', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.messages[0].content).not.toContain('a@x.com');
    expect(out.messages[0].content).not.toContain('b@y.com');
    expect(out.messages[0].content).toMatch(/<EMAIL_1>.*<EMAIL_2>/);
  });

  it('round-trips a tool-call input edit back into an object', () => {
    const input = { note: 'ci token', token: FAKE_GITHUB_PAT };
    const session = makeSession([
      makeMessage({ toolCalls: [{ id: 'tc', name: 'Set', input, status: 'completed' }] }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setDispositions(
      report,
      (f) => f.location.field === 'toolCallInput',
      'replace',
    );
    const { session: out } = applyDispositions(session, updated, mapper);
    const outInput = out.messages[0].toolCalls![0].input;
    expect(typeof outInput).toBe('object');
    // The secret is gone and the value is a redaction placeholder (the exact
    // rule id depends on which of the overlapping secret rules won).
    expect(JSON.stringify(outInput)).not.toContain(FAKE_GITHUB_PAT);
    expect(String(outInput.token)).toMatch(/^<SECRET:/);
    expect(outInput.note).toBe('ci token');
  });
});

describe('batch operations', () => {
  it('batch-by-type replaces two occurrences of the same email with one placeholder', () => {
    const original = 'dev@example.com and again dev@example.com';
    const session = makeSession([makeMessage({ content: original })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByType(report, 'email', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);
    const matches = out.messages[0].content.match(/<EMAIL_1>/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(out.messages[0].content).not.toContain('dev@example.com');
  });

  it('batch-by-rule replaces every hit of one gitleaks rule', () => {
    const patB = `ghp_${'b'.repeat(36)}`;
    const session = makeSession([
      makeMessage({ content: `first ${FAKE_GITHUB_PAT} second ${patB}` }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByRule(report, 'github-pat', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.messages[0].content).not.toMatch(/ghp_/);
  });
});

describe('gate enforcement + stamping', () => {
  it('refuses to stamp while a blocking hit is pending', () => {
    const session = makeSession([makeMessage({ content: `key ${FAKE_GITHUB_PAT}` })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const { session: out, stamped } = applyDispositions(session, report, mapper);
    expect(stamped).toBe(false);
    expect(out.meta.sanitized).toBe(false);
  });

  it('stamps the session once the gate is unlocked', () => {
    const session = makeSession([makeMessage({ content: `key ${FAKE_GITHUB_PAT}` })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByRule(report, 'github-pat', 'replace');
    const { session: out, stamped } = applyDispositions(session, updated, mapper);
    expect(stamped).toBe(true);
    expect(out.meta.sanitized).toBe(true);
    expect(out.meta.sanitizationRulesetVersion).toBe(report.sanitizationRulesetVersion);
  });

  it('produces a structurally isomorphic, schema-valid session', () => {
    const session = makeSession([
      makeMessage({
        content: `key ${FAKE_GITHUB_PAT}`,
        toolCalls: [{ id: 't', name: 'Bash', input: { cmd: 'ls' }, status: 'completed', result: 'ok' }],
      }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = batchByRule(report, 'github-pat', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(() => SanitizedSessionSchema.parse(out)).not.toThrow();
    expect(out.messages).toHaveLength(session.messages.length);
    expect(out.messages[0].toolCalls).toHaveLength(1);
    expect(out.messages[0].toolCalls![0].id).toBe('t');
    expect(out.schemaVersion).toBe(session.schemaVersion);
  });
});

describe('non-text handling', () => {
  it('retains kept non-text content through apply', () => {
    const session = makeSession([
      makeMessage({ content: 'shot', nonTextContent: { blockTypes: ['image'] } }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setNonTextDisposition(report, session.messages[0].sdkUuid, 'keep');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.messages[0].nonTextContent?.blockTypes).toContain('image');
  });

  it('never auto-strips non-text left at its default disposition', () => {
    const session = makeSession([
      makeMessage({ content: 'shot', nonTextContent: { blockTypes: ['image'] } }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    // Leave the non-text item pending (default). Apply must not drop it.
    const { session: out } = applyDispositions(session, report, mapper);
    expect(out.messages[0].nonTextContent?.blockTypes).toContain('image');
  });

  it('drops non-text only when explicitly removed', () => {
    const session = makeSession([
      makeMessage({ content: 'shot', nonTextContent: { blockTypes: ['image'] } }),
    ]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    const updated = setNonTextDisposition(report, session.messages[0].sdkUuid, 'remove');
    const { session: out } = applyDispositions(session, updated, mapper);
    expect(out.messages[0].nonTextContent).toBeUndefined();
  });
});
