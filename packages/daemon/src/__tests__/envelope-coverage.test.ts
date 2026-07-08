import type { SanitizationReport } from '@mosga/sanitizer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_GITHUB_PAT, makeTempDir, plainTurn, rm, withServer, writeSession } from './_helpers.js';

interface CreateResponse {
  reviewId: string;
  report: SanitizationReport;
}

/**
 * A projectKey (== on-disk project slug) carrying a planted fake secret. The
 * slug is a valid directory name, so the daemon's `session.projectKey` inherits
 * the secret — proving the widened scan reaches the human review gate, not just
 * the sanitizer unit boundary.
 */
const SECRET_SLUG = `proj-${FAKE_GITHUB_PAT}`;

describe('review-gate visibility of envelope-field coverage (mosga-v02)', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    // A benign session under a secret-bearing project slug: the only secret is
    // in session.projectKey, isolating the newly covered field.
    writeSession(home, SECRET_SLUG, 'sess-x', cwd, [plainTurn('u1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
  });

  it('surfaces a projectKey secret in the review report and keeps the gate locked (8.1)', async () => {
    await withServer({ homeDir: home, now: '2026-07-07T00:00:00.000Z' }, async (base) => {
      const res = await fetch(`${base}/api/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: 'claude-code', projectKey: SECRET_SLUG, sessionId: 'sess-x' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateResponse;

      const secret = body.report.findings.find(
        (f) => f.blocking && f.location.field === 'sessionProjectKey',
      );
      expect(secret).toBeDefined();
      expect(secret!.layer).toBe('secrets');
      expect(body.report.gate.blockingPending).toBeGreaterThan(0);
      expect(body.report.gate.unlocked).toBe(false);
    });
  });
});
