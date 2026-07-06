import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SanitizationReport } from '@mosga/sanitizer';

import {
  imageTurn,
  makeTempDir,
  rm,
  secretTurn,
  withServer,
  writeSession,
} from './_helpers.js';

interface CreateResponse {
  reviewId: string;
  report: SanitizationReport;
  rulesetWarnings: unknown[];
}

async function createReview(base: string, home: string): Promise<CreateResponse> {
  void home;
  const res = await fetch(`${base}/api/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'claude-code', projectKey: 'projX', sessionId: 'sess-x' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateResponse;
}

describe('review lifecycle + scan', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    writeSession(home, 'projX', 'sess-x', cwd, [secretTurn('u1'), imageTurn('u2', 'u1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
  });

  it('creates a review returning reviewId, report, and rulesetWarnings', async () => {
    await withServer({ homeDir: home, now: '2026-07-07T00:00:00.000Z' }, async (base) => {
      const body = await createReview(base, home);
      expect(body.reviewId).toBeTruthy();
      expect(Array.isArray(body.rulesetWarnings)).toBe(true);
      // Planted fake secrets are found and are blocking.
      expect(body.report.gate.blockingPending).toBeGreaterThanOrEqual(2);
      // The image turn surfaced a non-text item.
      expect(body.report.nonTextItems.length).toBe(1);
      expect(body.report.gate.unlocked).toBe(false);
    });
  });

  it('reuses the SAME mapper instance at export (contributorAlias consistency)', async () => {
    await withServer({ homeDir: home, now: '2026-07-07T00:00:00.000Z' }, async (base, daemon) => {
      const { reviewId, report } = await createReview(base, home);

      // The alias the held mapper would produce (a fresh mapper would not have
      // the username table and would fall back to '<CONTRIBUTOR>').
      const state = daemon.app.store.get(reviewId);
      expect(state).toBeDefined();
      const expectedAlias = state!.mapper.primaryContributorAlias();
      expect(expectedAlias).toBe('<USER_1>');

      // Disposition every blocking finding + non-text item to unlock.
      for (const f of report.findings.filter((x) => x.blocking)) {
        await fetch(`${base}/api/reviews/${reviewId}/findings/${f.id}/disposition`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ disposition: 'replace' }),
        });
      }
      for (const n of report.nonTextItems) {
        await fetch(`${base}/api/reviews/${reviewId}/nontext/${n.messageUuid}/disposition`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ disposition: 'keep' }),
        });
      }

      const exported = (await (
        await fetch(`${base}/api/reviews/${reviewId}/export`, { method: 'POST' })
      ).json()) as { session: { meta: { contributorAlias: string } } };
      expect(exported.session.meta.contributorAlias).toBe(expectedAlias);
    });
  });
});
