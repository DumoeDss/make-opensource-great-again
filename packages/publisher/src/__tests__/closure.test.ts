import type { SanitizedSession } from '@mosga/contracts';
import { applyDispositions, compileRuleset, scanSession, setDispositions } from '@mosga/sanitizer';
import { describe, expect, it } from 'vitest';

import {
  type CommandRunner,
  type RunResult,
  exportSession,
  planContribution,
  precheckRecord,
  stageContribution,
} from '../index.js';
import { FAKE_GITHUB_PAT, SANITIZER_PACKAGE_VERSION, makeMessage } from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

/** Records commands; reports git+gh present but performs nothing real. */
class HermeticRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string, args: string[]): RunResult {
    this.calls.push(`${command} ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '' };
  }
}

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

describe('v0.1 loop closure (read → scan → gate → export → pre-check → PR-prep)', () => {
  it('carries a fake session through the whole pipeline to a staged, dry-run PR', () => {
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

    // export the stamped envelope
    const record = exportSession(applied.session, {
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
    });
    // The published bytes no longer contain the raw secret.
    expect(record.jsonl).not.toContain(FAKE_GITHUB_PAT);

    // mandatory pre-check on the exact bytes → passes now that the secret is gone
    const precheck = precheckRecord(record.jsonl, { generatedAt: AT });
    expect(precheck.ok).toBe(true);

    // PR-prep (dry-run) → the contribution stages cleanly, no live external PR
    const runner = new HermeticRunner();
    const plan = planContribution(applied.session, {
      targetRepo: '/tmp/does-not-matter',
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      runner,
      generatedAt: AT,
    });
    expect(plan.branch).toBe('contrib/CONTRIBUTOR/loop-1');
    expect(plan.provenance.sanitizationRulesetVersion).toBe(ruleset.rulesetVersion);

    // No network / no live PR was invoked anywhere in the loop.
    expect(runner.calls.every((c) => !c.includes('pr create') && !c.includes('push'))).toBe(true);
  });
});
