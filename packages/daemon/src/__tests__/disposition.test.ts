import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CompiledRuleset,
  type NormalizedRule,
  type SanitizationReport,
  compileRuleset,
} from '@mosga/sanitizer';

import { makeTempDir, plainTurn, rm, secretTurn, withServer, writeSession } from './_helpers.js';

async function create(base: string, projectKey: string, sessionId: string): Promise<{
  reviewId: string;
  report: SanitizationReport;
}> {
  const res = await fetch(`${base}/api/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'claude-code', projectKey, sessionId }),
  });
  return (await res.json()) as { reviewId: string; report: SanitizationReport };
}

function setDisposition(
  base: string,
  reviewId: string,
  findingId: string,
  disposition: string,
): Promise<Response> {
  return fetch(`${base}/api/reviews/${reviewId}/findings/${findingId}/disposition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ disposition }),
  });
}

/** A ruleset whose single rule cannot compile on this runtime and has no
 *  keyword fallback → scanSession emits a blocking `ruleset-compile-error`. */
function brokenRuleset(): CompiledRuleset {
  const base = compileRuleset({ generatedAt: '2026-07-07T00:00:00.000Z' });
  const broken: NormalizedRule = {
    id: 'broken-rule',
    description: '',
    regexSource: '(', // invalid — `new RegExp('(')` throws
    flags: '',
    keywords: [],
    translation: { status: 'native', notes: '' },
  };
  return { ...base, rules: [broken], customRules: [] };
}

describe('disposition, batch, gate routes', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    // Secrets, no image → blocking findings only, nonTextPending 0.
    writeSession(home, 'projS', 'sess-s', cwd, [secretTurn('u1')]);
    // Benign session for the injected-broken-ruleset compile-error test.
    writeSession(home, 'projP', 'sess-p', cwd, [plainTurn('p1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
  });

  it('flips gate.unlocked when the last pending blocking finding is dispositioned', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const { reviewId, report } = await create(base, 'projS', 'sess-s');
      const blocking = report.findings.filter((f) => f.blocking);
      expect(blocking.length).toBeGreaterThanOrEqual(2);
      expect(report.gate.unlocked).toBe(false);

      // Disposition every blocking finding but the last; the gate stays locked.
      for (let i = 0; i < blocking.length; i += 1) {
        const body = (await (
          await setDisposition(base, reviewId, blocking[i].id, 'replace')
        ).json()) as { report: SanitizationReport };
        const isLast = i === blocking.length - 1;
        expect(body.report.gate.unlocked).toBe(isLast);
        if (!isLast) expect(body.report.gate.blockingPending).toBeGreaterThan(0);
        else expect(body.report.gate.blockingPending).toBe(0);
      }
    });
  });

  it('batch-by-type replaces all findings of a category', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const { reviewId, report } = await create(base, 'projS', 'sess-s');
      const category = report.findings.find((f) => f.category)?.category;
      expect(category).toBeDefined();
      const res = await fetch(`${base}/api/reviews/${reviewId}/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ by: 'type', key: category, disposition: 'replace' }),
      });
      const body = (await res.json()) as { report: SanitizationReport };
      const ofCategory = body.report.findings.filter((f) => f.category === category);
      expect(ofCategory.length).toBeGreaterThan(0);
      expect(ofCategory.every((f) => f.disposition === 'replace')).toBe(true);
    });
  });

  it('rejects an invalid disposition without mutating the review', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const { reviewId, report } = await create(base, 'projS', 'sess-s');
      const finding = report.findings.find((f) => f.blocking)!;
      const res = await setDisposition(base, reviewId, finding.id, 'bogus');
      expect(res.status).toBe(400);
      const after = (await (await fetch(`${base}/api/reviews/${reviewId}`)).json()) as {
        report: SanitizationReport;
      };
      // Unchanged: the targeted finding is still pending.
      const stillPending = after.report.findings.find((f) => f.id === finding.id);
      expect(stillPending?.disposition).toBe('pending');
    });
  });

  it('keeps the gate locked on a pending ruleset-compile-error until dispositioned', async () => {
    await withServer({ homeDir: home, ruleset: brokenRuleset() }, async (base) => {
      const { reviewId, report } = await create(base, 'projP', 'sess-p');
      const compileError = report.findings.find((f) => f.ruleId === 'ruleset-compile-error');
      expect(compileError).toBeDefined();
      expect(compileError!.blocking).toBe(true);
      expect(report.gate.unlocked).toBe(false);

      // Acknowledge (allow) the meta finding → gate unlocks.
      const res = await setDisposition(base, reviewId, compileError!.id, 'allow');
      const body = (await res.json()) as { gate: { unlocked: boolean } };
      expect(body.gate.unlocked).toBe(true);
    });
  });
});
