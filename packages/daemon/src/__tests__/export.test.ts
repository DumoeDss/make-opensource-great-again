import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SanitizationReport, SanitizedSession } from '@mosga/sanitizer';

import {
  imageTurn,
  makeTempDir,
  rm,
  secretTurn,
  withServer,
  writeSession,
} from './_helpers.js';

describe('preview + gated export (end-to-end through the real engine)', () => {
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

  it('refuses export with 409 while the gate is locked, then stamps once unlocked', async () => {
    await withServer({ homeDir: home, now: '2026-07-07T00:00:00.000Z' }, async (base) => {
      const created = (await (
        await fetch(`${base}/api/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceId: 'claude-code', projectKey: 'projX', sessionId: 'sess-x' }),
        })
      ).json()) as { reviewId: string; report: SanitizationReport };
      const { reviewId, report } = created;

      // Locked → 409 with the gate, no stamped session.
      const locked = await fetch(`${base}/api/reviews/${reviewId}/export`, { method: 'POST' });
      expect(locked.status).toBe(409);
      const lockedBody = (await locked.json()) as { gate: { unlocked: boolean }; session?: unknown };
      expect(lockedBody.gate.unlocked).toBe(false);
      expect(lockedBody.session).toBeUndefined();

      // Disposition every blocking finding + confirm the non-text item.
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

      // Unlocked → stamped envelope.
      const ok = await fetch(`${base}/api/reviews/${reviewId}/export`, { method: 'POST' });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { session: SanitizedSession };
      expect(body.session.meta.sanitized).toBe(true);
      expect(body.session.meta.sanitizationRulesetVersion).toContain('gitleaks@');
      // Structure isomorphic to input: both source turns are preserved.
      expect(body.session.messages.length).toBe(2);
      expect(body.session.schemaVersion).toBe('0.1.0');
    });
  });

  it('preview returns a partially-applied session even while locked (never stamped)', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const created = (await (
        await fetch(`${base}/api/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceId: 'claude-code', projectKey: 'projX', sessionId: 'sess-x' }),
        })
      ).json()) as { reviewId: string };
      const preview = (await (
        await fetch(`${base}/api/reviews/${created.reviewId}/preview`, { method: 'POST' })
      ).json()) as { session: SanitizedSession; stamped: boolean };
      expect(preview.stamped).toBe(false);
      expect(preview.session.meta.sanitized).toBe(false);
    });
  });
});
