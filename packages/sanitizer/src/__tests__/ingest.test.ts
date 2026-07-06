import { describe, expect, it } from 'vitest';

import { compileRuleset, loadCustomRules } from '../ingest.js';
import { translateRe2ToJs } from '../translate.js';

const AT = '2026-07-07T00:00:00.000Z';

// A tiny synthetic gitleaks-style config (hand-written, not the vendored file)
// exercising each translation state.
const SYNTHETIC_TOML = `
[allowlist]
description = "global"
stopwords = ["notasecret"]

[[rules]]
id = "named-cap"
description = "named capture"
regex = '''(?P<secret>AKIA[A-Z0-9]{16})'''
keywords = ["akia"]

[[rules]]
id = "backref-rule"
description = "unsupported back-reference"
regex = '''(?P<x>abc)(?P=x)'''
keywords = ["abc"]

[[rules]]
id = "no-keyword-untranslatable"
description = "no keyword fallback"
regex = '''(?P=zzz)'''
`;

describe('RE2 → JS translation', () => {
  it('translates a named-capture pattern to a working RegExp', () => {
    const t = translateRe2ToJs('(?P<secret>AKIA[A-Z0-9]{16})');
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.regexSource).toContain('(?<secret>');
      expect(['native', 'translated']).toContain(t.status);
      expect(() => new RegExp(t.regexSource, t.flags)).not.toThrow();
    }
  });

  it('degrades (does not throw) on an unsupported back-reference', () => {
    const t = translateRe2ToJs('(?P=name)');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toMatch(/back-reference/i);
  });

  it('hoists a mid-pattern (?i) inline flag rather than failing', () => {
    const t = translateRe2ToJs('(LTAI)(?i)[a-z0-9]{20}');
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.status).toBe('translated');
      expect(t.flags).toContain('i');
      expect(t.regexSource).not.toContain('(?i)');
    }
  });
});

describe('ruleset ingestion + degradation manifest', () => {
  it('classifies each rule and conserves the rule count', () => {
    const rs = compileRuleset({ tomlText: SYNTHETIC_TOML, generatedAt: AT });
    const byId = new Map(rs.rules.map((r) => [r.id, r]));

    expect(byId.get('named-cap')?.translation.status).toMatch(/native|translated/);
    // back-ref rule has keywords → degraded to a keyword literal matcher.
    expect(byId.get('backref-rule')?.translation.status).toBe('degraded');
    // no keywords and untranslatable → disabled.
    expect(byId.get('no-keyword-untranslatable')?.translation.status).toBe('disabled');

    const counts = { native: 0, translated: 0, degraded: 0, disabled: 0 };
    for (const r of rs.rules) counts[r.translation.status] += 1;
    expect(counts.native + counts.translated + counts.degraded + counts.disabled).toBe(
      rs.rules.length,
    );
    expect(rs.rules.length).toBe(3);
  });

  it('lists every non-native rule in degraded[] with a reason', () => {
    const rs = compileRuleset({ tomlText: SYNTHETIC_TOML, generatedAt: AT });
    const manifest = new Map(rs.degraded.map((d) => [d.id, d]));
    expect(manifest.get('backref-rule')?.status).toBe('degraded');
    expect(manifest.get('backref-rule')?.reason.length).toBeGreaterThan(0);
    expect(manifest.get('no-keyword-untranslatable')?.status).toBe('disabled');
    expect(manifest.get('no-keyword-untranslatable')?.reason.length).toBeGreaterThan(0);
  });

  it('conserves the count over the real vendored ruleset', () => {
    const rs = compileRuleset({ generatedAt: AT });
    const counts = { native: 0, translated: 0, degraded: 0, disabled: 0 };
    for (const r of rs.rules) counts[r.translation.status] += 1;
    expect(counts.native + counts.translated + counts.degraded + counts.disabled).toBe(
      rs.rules.length,
    );
    // Every non-native rule is accounted for in the manifest.
    expect(rs.degraded.length).toBe(counts.degraded + counts.disabled);
  });
});

describe('custom rules', () => {
  it('keeps a literal rule and reports+skips an invalid regex', () => {
    const { rules, errors } = loadCustomRules([
      { id: 'company', kind: 'literal', pattern: 'Acme.Corp*Internal' },
      { id: 'bad-regex', kind: 'regex', pattern: '(?P=q)' },
      { id: 'ok-regex', kind: 'regex', pattern: 'INT-[0-9]{4}' },
    ]);
    expect(rules.map((r) => r.id)).toEqual(['company', 'ok-regex']);
    expect(errors.map((e) => e.id)).toContain('bad-regex');
  });
});

describe('compiled artifact determinism + versioning', () => {
  it('produces an identical rule set on repeated compiles', () => {
    const a = compileRuleset({ tomlText: SYNTHETIC_TOML, generatedAt: AT });
    const b = compileRuleset({ tomlText: SYNTHETIC_TOML, generatedAt: AT });
    expect(a.rules).toEqual(b.rules);
    expect(a.rulesetVersion).toBe(b.rulesetVersion);
  });

  it('changes rulesetVersion when the custom-rule set changes', () => {
    const base = compileRuleset({ generatedAt: AT });
    const withCustom = compileRuleset({
      generatedAt: AT,
      customRules: [{ id: 'company', kind: 'literal', pattern: 'Acme' }],
    });
    expect(withCustom.rulesetVersion).not.toBe(base.rulesetVersion);
  });
});
