import type { SanitizedSession } from '@mosga/contracts';
import { applyDispositions, compileRuleset, scanSession, setDispositions } from '@mosga/sanitizer';
import { describe, expect, it } from 'vitest';

import {
  compileContributionBundle,
} from '../index.js';
import {
  FAKE_GITHUB_PAT,
  GITLEAKS_PIN,
  SANITIZER_PACKAGE_VERSION,
  makeMessage,
} from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

/** A RAW (unsanitized) session as it comes out of the readers, with a fake leak. */
function rawSession(): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: '0.1.0',
      sanitizationRulesetVersion: null,
      exportedAt: AT,
      license: null,
      sanitized: false,
    },
    session: {
      sessionId: 'loop-1',
      sourceId: 'claude-code',
      projectKey: 'proj-1',
      cwd: null,
      title: null,
      updatedAt: 1_700_000_000_000,
    },
    messages: [
      makeMessage({ role: 'user', content: 'Deploy the service.' }),
      makeMessage({ role: 'assistant', content: `Using token ${FAKE_GITHUB_PAT} to deploy.` }),
    ],
  };
}

describe('v0.1 content loop closure (read → scan → gate → pure contribution bundle)', () => {
  it('carries a fake session through the whole pipeline to exact sealed-ready bytes', () => {
    // read → scan
    const raw = rawSession();
    const ruleset = compileRuleset({ generatedAt: AT });
    const { report, mapper } = scanSession(raw, ruleset, { generatedAt: AT });

    // The raw session leaks a secret → the gate starts locked.
    expect(report.gate.unlocked).toBe(false);
    expect(report.findings.some((f) => f.blocking)).toBe(true);

    // human gate: disposition every blocking finding (here: replace the secret).
    const dispositioned = setDispositions(report, (f) => f.blocking, 'replace');
    const applied = applyDispositions(raw, dispositioned, mapper);
    expect(applied.stamped).toBe(true);
    expect(applied.session.meta.sanitized).toBe(true);
    expect(applied.session.meta.sanitizationRulesetVersion).toBe(ruleset.rulesetVersion);

    // The pure compiler exports, prechecks, hashes, and renders the complete
    // target-independent contract in one synchronous in-memory operation.
    const bundle = compileContributionBundle([applied.session], {
      ruleset,
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
      generatedAt: AT,
    });
    const recordFile = bundle.files.find((file) => file.kind === 'record')!;
    const provenanceFile = bundle.files.find((file) => file.kind === 'provenance')!;
    const publishedRecord = JSON.parse(recordFile.contents) as SanitizedSession;

    expect(recordFile.contents).not.toContain(FAKE_GITHUB_PAT);
    expect(recordFile.contents.endsWith('\n')).toBe(true);
    expect(publishedRecord.messages).toEqual(applied.session.messages);
    expect(publishedRecord.session.projectKey).toBe('redacted-project');
    expect(JSON.parse(provenanceFile.contents)).toMatchObject({
      sanitizationRulesetVersion: ruleset.rulesetVersion,
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
    expect(bundle.branch).toMatch(/^contrib\/%3CCONTRIBUTOR%3E\/loop-1-[0-9a-f]{8}$/);
    expect(bundle.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.totalBytes).toBe(bundle.files.reduce((total, file) => total + file.bytes, 0));
    expect(bundle).not.toHaveProperty('targetRepo');
    expect(bundle).not.toHaveProperty('workspace');
    expect(bundle).not.toHaveProperty('commands');
    expect(bundle).not.toHaveProperty('ghAvailable');
    expect(bundle).not.toHaveProperty('delivery');
  });
});
