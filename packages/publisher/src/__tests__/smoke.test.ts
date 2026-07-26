import { describe, expect, it } from 'vitest';

import { compileContributionBundle, resolveSanitizerPackageVersion } from '../index.js';
import {
  GITLEAKS_PIN,
  RULESET,
  RULESET_VERSION,
  SANITIZER_PACKAGE_VERSION,
  cleanSession,
} from './_fixtures.js';

describe('@mosga/publisher smoke', () => {
  it('compiles a complete pure bundle for a clean stamped session', () => {
    const bundle = compileContributionBundle([cleanSession()], {
      ruleset: RULESET,
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });

    expect(bundle.contractVersion).toBe(1);
    expect(bundle.recordCount).toBe(1);
    expect(bundle.records).toEqual([
      {
        sessionId: 'sess-abc123',
        messages: 2,
        recordPath: 'data/0.1.0/%3CUSERNAME_1%3E/sess-abc123.jsonl',
        provenancePath: 'data/0.1.0/%3CUSERNAME_1%3E/sess-abc123.provenance.json',
      },
    ]);
    expect(bundle.files.map((file) => [file.kind, file.path])).toEqual([
      ['record', 'data/0.1.0/%3CUSERNAME_1%3E/sess-abc123.jsonl'],
      ['provenance', 'data/0.1.0/%3CUSERNAME_1%3E/sess-abc123.provenance.json'],
    ]);
    expect(bundle.files.every((file) => file.contents.endsWith('\n'))).toBe(true);
    expect(bundle.totalBytes).toBe(bundle.files.reduce((total, file) => total + file.bytes, 0));
    expect(bundle.engine).toEqual({
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      rulesetVersion: RULESET_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
    for (const forbidden of [
      'path',
      'targetRepo',
      'targetBranch',
      'commands',
      'ghAvailable',
      'delivery',
      'result',
    ]) {
      expect(bundle).not.toHaveProperty(forbidden);
    }
  });

  it('returns the build-time @mosga/sanitizer package version', () => {
    expect(resolveSanitizerPackageVersion()).toBe(SANITIZER_PACKAGE_VERSION);
  });
});
