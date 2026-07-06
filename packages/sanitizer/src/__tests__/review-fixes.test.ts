import { describe, expect, it } from 'vitest';

import { applyDispositions, batchByType, setDispositions } from '../apply.js';
import { compileRuleset } from '../ingest.js';
import type { CompiledRuleset } from '../schemas.js';
import { scanSession } from '../scan.js';
import { makeMessage, makeSession } from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

let ruleset: CompiledRuleset;
function rs(): CompiledRuleset {
  if (!ruleset) ruleset = compileRuleset({ generatedAt: AT });
  return ruleset;
}

// B1 — EMAIL_RE ReDoS: a large tokenless field (the exact input that backtracked
// ~57s before) must now scan in linear time, well within budget.
describe('B1: ReDoS-safe large-field scan', () => {
  it('scans a ~200k tokenless field in far under the old ~57s', () => {
    // Long run of [A-Za-z0-9] with no "@": the catastrophic-backtracking trigger
    // for the previous unbounded email regex. ~199k chars (below the 200k cap).
    const field = 'a1B2c3D4'.repeat(24_875);
    expect(field.length).toBe(199_000);
    const session = makeSession([makeMessage({ content: field })]);
    const t0 = Date.now();
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
    // No spurious email finding on tokenless input.
    expect(report.findings.some((f) => f.category === 'email')).toBe(false);
  });
});

// M1 — overlapping path + username replace must not leak the inner directory /
// project name. The outer (path) edit must win.
describe('M1: overlapping path+username replace does not leak', () => {
  it('replacing both categories removes the whole path, not just the username', () => {
    const content = 'opened /home/alice/secretproj/app.ts here';
    const session = makeSession([makeMessage({ content })]);
    const { report, mapper } = scanSession(session, rs(), { generatedAt: AT });
    let updated = batchByType(report, 'path', 'replace');
    updated = batchByType(updated, 'username', 'replace');
    const { session: out } = applyDispositions(session, updated, mapper);
    const outText = out.messages[0].content;
    expect(outText).not.toContain('secretproj');
    expect(outText).not.toContain('alice');
    expect(outText).toContain('<PATH_1>');
  });
});

// M2 — a custom-rule replacement containing JSON-special characters must not
// crash the apply pass on a toolCallInput edit.
describe('M2: JSON-special replacement in toolCallInput', () => {
  it('applies without throwing and round-trips to a valid object', () => {
    const replacement = 'X"Y{Z}\\W';
    const customRs = compileRuleset({
      generatedAt: AT,
      customRules: [{ id: 'brand', kind: 'literal', pattern: 'ZephyrCorp', replacement }],
    });
    const input = { note: 'about ZephyrCorp internal usage' };
    const session = makeSession([
      makeMessage({ toolCalls: [{ id: 'tc', name: 'Set', input, status: 'completed' }] }),
    ]);
    const { report, mapper } = scanSession(session, customRs, { generatedAt: AT });
    const updated = setDispositions(report, (f) => f.location.field === 'toolCallInput', 'replace');

    let out!: ReturnType<typeof applyDispositions>['session'];
    expect(() => {
      out = applyDispositions(session, updated, mapper).session;
    }).not.toThrow();

    const outInput = out.messages[0].toolCalls![0].input;
    expect(typeof outInput).toBe('object');
    expect(JSON.stringify(outInput)).not.toContain('ZephyrCorp');
    // The JSON-special replacement survives verbatim through the re-parse.
    expect(String(outInput.note)).toContain(replacement);
  });
});

// M3 — a rule that fails to compile at scan time must surface (never vanish).
describe('M3: scan-time compile failure surfaces, never silently dropped', () => {
  it('degrades a keyworded bad rule to a keyword matcher and blocks a keywordless one', () => {
    const bad: CompiledRuleset = {
      rulesetVersion: 'test',
      gitleaksVersion: 'test',
      generatedAt: AT,
      rules: [
        {
          id: 'bad-with-keyword',
          description: '',
          regexSource: '(', // invalid on every runtime → forces compile failure
          flags: '',
          keywords: ['zephyrsecret'],
          translation: { status: 'translated', notes: '' },
        },
        {
          id: 'bad-no-keyword',
          description: '',
          regexSource: '(',
          flags: '',
          keywords: [],
          translation: { status: 'translated', notes: '' },
        },
      ],
      customRules: [],
      degraded: [],
    };
    const session = makeSession([makeMessage({ content: 'here is zephyrsecret in text' })]);
    const { report, rulesetWarnings } = scanSession(session, bad, { generatedAt: AT });

    const warned = new Map(rulesetWarnings.map((w) => [w.ruleId, w]));
    expect(warned.get('bad-with-keyword')?.degradedTo).toBe('keyword');
    expect(warned.get('bad-no-keyword')?.degradedTo).toBe('none');

    // The keyworded rule still RUNS (did not vanish) via its keyword matcher.
    expect(report.findings.some((f) => f.ruleId === 'bad-with-keyword')).toBe(true);
    // The keywordless rule surfaces as a blocking, gating warning finding.
    const compileError = report.findings.find((f) => f.ruleId === 'ruleset-compile-error');
    expect(compileError?.blocking).toBe(true);
    expect(report.gate.unlocked).toBe(false);
  });
});
