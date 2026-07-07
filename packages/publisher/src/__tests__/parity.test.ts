import { describe, expect, it } from 'vitest';

import { type EngineInfo, checkEngineParity } from '../index.js';
import { GITLEAKS_PIN, RULESET_VERSION, SANITIZER_PACKAGE_VERSION } from './_fixtures.js';

const ENGINE: EngineInfo = {
  sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
  rulesetVersion: RULESET_VERSION,
  gitleaksVersion: GITLEAKS_PIN,
};

const MATCHING_STAMP = {
  sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
  sanitizationRulesetVersion: RULESET_VERSION,
  gitleaksVersion: GITLEAKS_PIN,
};

describe('CI version-parity check (M2)', () => {
  it('passes when the provenance stamp matches the scanning engine exactly', () => {
    const result = checkEngineParity(MATCHING_STAMP, ENGINE);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('FAILS on a mismatched sanitizerPackageVersion (silent divergence becomes visible)', () => {
    const result = checkEngineParity(
      { ...MATCHING_STAMP, sanitizerPackageVersion: '0.0.9-EVIL' },
      ENGINE,
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.join('\n')).toContain('sanitizerPackageVersion');
  });

  it('FAILS on a mismatched ruleset baseline (different gitleaks/mosga-l3 versions)', () => {
    const result = checkEngineParity(
      { ...MATCHING_STAMP, sanitizationRulesetVersion: 'gitleaks@v0.0.0+mosga-l3@0.0.0+custom@none' },
      ENGINE,
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches.join('\n')).toContain('ruleset baseline');
  });

  it('FAILS on a mismatched gitleaksVersion', () => {
    const result = checkEngineParity({ ...MATCHING_STAMP, gitleaksVersion: 'v0.0.0' }, ENGINE);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join('\n')).toContain('gitleaksVersion');
  });

  // Finding M2b: the additive custom@ segment MUST be allowed to differ, else a
  // community enabling its own custom rules (custom@<hash>) rejects every
  // contributor artifact (custom@none) even though the shared baseline agrees.
  it('PASSES when only the additive custom@ segment differs (contributor custom@none vs CI custom@<hash>)', () => {
    const [baseline] = RULESET_VERSION.split('+custom@');
    const contributorStamp = {
      ...MATCHING_STAMP,
      sanitizationRulesetVersion: `${baseline}+custom@none`,
    };
    const ciEngine: EngineInfo = {
      ...ENGINE,
      rulesetVersion: `${baseline}+custom@ab12cd34`,
    };
    const result = checkEngineParity(contributorStamp, ciEngine);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('still FAILS when the baseline differs even if the custom@ segment matches', () => {
    const contributorStamp = {
      ...MATCHING_STAMP,
      sanitizationRulesetVersion: 'gitleaks@v0.0.0+mosga-l3@0.0.0+custom@ab12cd34',
    };
    const ciEngine: EngineInfo = {
      ...ENGINE,
      rulesetVersion: `${RULESET_VERSION.split('+custom@')[0]}+custom@ab12cd34`,
    };
    const result = checkEngineParity(contributorStamp, ciEngine);
    expect(result.ok).toBe(false);
    expect(result.mismatches.join('\n')).toContain('ruleset baseline');
  });

  it('FAILS CLOSED on a missing provenance sidecar (absent stamp is never trusted)', () => {
    expect(checkEngineParity(null, ENGINE).ok).toBe(false);
    expect(checkEngineParity(undefined, ENGINE).ok).toBe(false);
    expect(checkEngineParity(null, ENGINE).mismatches.join('\n')).toContain('missing provenance');
  });
});
