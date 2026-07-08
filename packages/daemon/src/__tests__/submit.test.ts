import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SanitizationReport } from '@mosga/sanitizer';
import type { OutboundRequest } from '@mosga/direct-submit';

import { makeTempDir, plainTurn, rm, secretTurn, withServer, writeSession } from './_helpers.js';

const NOW = '2026-07-09T00:00:00.000Z';
const FAKE_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

interface Created {
  reviewId: string;
  report: SanitizationReport;
}

async function createReview(base: string, projectKey: string): Promise<Created> {
  return (await (
    await fetch(`${base}/api/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'claude-code', projectKey, sessionId: `sess-${projectKey}` }),
    })
  ).json()) as Created;
}

async function unlock(base: string, r: Created): Promise<void> {
  for (const f of r.report.findings.filter((x) => x.blocking)) {
    await fetch(`${base}/api/reviews/${r.reviewId}/findings/${f.id}/disposition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'replace' }),
    });
  }
  for (const n of r.report.nonTextItems) {
    await fetch(`${base}/api/reviews/${r.reviewId}/nontext/${n.messageUuid}/disposition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'remove' }),
    });
  }
}

describe('出口② daemon routes', () => {
  let home: string;
  let cwd: string;
  let keyConfigPath: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    // A session that unlocks to CLEAN bytes (secrets get replaced on disposition).
    writeSession(home, 'projX', 'sess-projX', cwd, [secretTurn('u1'), plainTurn('u2', 'all good now')]);
    keyConfigPath = path.join(makeTempDir('mosga-key-'), 'keys.json');
    fs.writeFileSync(keyConfigPath, JSON.stringify({ deepseek: FAKE_KEY }), 'utf-8');
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
    rm(path.dirname(keyConfigPath));
  });

  it('GET /api/providers lists providers with no key material', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const res = await fetch(`${base}/api/providers`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as { providers: Array<{ id: string; models: string[] }> };
      expect(body.providers.some((p) => p.id === 'deepseek')).toBe(true);
      expect(raw).not.toContain(FAKE_KEY);
      expect(raw.toLowerCase()).not.toContain('api_key');
    });
  });

  it('estimate returns a token estimate + content hash and sends NOTHING', async () => {
    const sent: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      sent.push(req);
      return { status: 200, usage: null };
    };
    await withServer({ homeDir: home, now: NOW, submitTransport }, async (base) => {
      const r = await createReview(base, 'projX');
      const res = await fetch(`${base}/api/reviews/${r.reviewId}/submit/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'deepseek', model: 'deepseek-v4-flash', replayMode: 'single-shot' }),
      });
      expect(res.status).toBe(200);
      const est = (await res.json()) as {
        totalTokens: number;
        contentHash: string;
        pricingSource: string;
      };
      expect(est.totalTokens).toBeGreaterThan(0);
      expect(est.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // deepseek is in the provider-pricing table → provider-specific basis.
      expect(est.pricingSource).toBe('provider');
      expect(sent).toHaveLength(0);
    });

    // Unknown review → 404.
    await withServer({ homeDir: home }, async (base) => {
      const res = await fetch(`${base}/api/reviews/nope/submit/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'deepseek', model: 'deepseek-v4-flash' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('submit is 409 while the gate is locked (nothing sent)', async () => {
    const sent: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      sent.push(req);
      return { status: 200, usage: null };
    };
    await withServer({ homeDir: home, submitTransport, providerKeyConfigPath: keyConfigPath }, async (base) => {
      const r = await createReview(base, 'projX');
      const res = await fetch(`${base}/api/reviews/${r.reviewId}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: 'deepseek',
          model: 'deepseek-v4-flash',
          consent: {
            consentVersion: '0.2.0',
            tosRiskAcknowledged: true,
            fullRetentionAcknowledged: true,
            targetProviderId: 'deepseek',
            targetModel: 'deepseek-v4-flash',
            replayMode: 'single-shot',
            estimatedTokens: 100,
            contentHash: '0'.repeat(64),
            confirmedAt: NOW,
          },
        }),
      });
      expect(res.status).toBe(409);
      expect(sent).toHaveLength(0);
    });
  });

  it('a missing provider key is a 400 with a stable code and sends nothing', async () => {
    const sent: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      sent.push(req);
      return { status: 200, usage: null };
    };
    // No providerKeyConfigPath and no env key configured for deepseek.
    await withServer({ homeDir: home, now: NOW, submitTransport }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r);
      const est = (await (
        await fetch(`${base}/api/reviews/${r.reviewId}/submit/estimate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerId: 'deepseek', model: 'deepseek-v4-flash' }),
        })
      ).json()) as { contentHash: string };
      const res = await fetch(`${base}/api/reviews/${r.reviewId}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: 'deepseek',
          model: 'deepseek-v4-flash',
          consent: {
            consentVersion: '0.2.0',
            tosRiskAcknowledged: true,
            fullRetentionAcknowledged: true,
            targetProviderId: 'deepseek',
            targetModel: 'deepseek-v4-flash',
            replayMode: 'single-shot',
            estimatedTokens: 100,
            contentHash: est.contentHash,
            confirmedAt: NOW,
          },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('KEY_NOT_CONFIGURED');
      expect(sent).toHaveLength(0);
    });
  });

  it('invalid consent (hash mismatch) is 422; valid consent returns a key-free receipt', async () => {
    const sent: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      sent.push(req);
      return { status: 200, usage: { inputTokens: 12, outputTokens: 3 } };
    };
    await withServer(
      { homeDir: home, now: NOW, submitTransport, providerKeyConfigPath: keyConfigPath },
      async (base) => {
        const r = await createReview(base, 'projX');
        await unlock(base, r);

        // Get the authoritative content hash from the estimate endpoint.
        const est = (await (
          await fetch(`${base}/api/reviews/${r.reviewId}/submit/estimate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId: 'deepseek', model: 'deepseek-v4-flash' }),
          })
        ).json()) as { contentHash: string; totalTokens: number };

        const baseConsent = {
          consentVersion: '0.2.0',
          tosRiskAcknowledged: true,
          fullRetentionAcknowledged: true,
          targetProviderId: 'deepseek',
          targetModel: 'deepseek-v4-flash',
          replayMode: 'single-shot' as const,
          estimatedTokens: est.totalTokens,
          confirmedAt: NOW,
        };

        // Wrong hash → 422, nothing sent.
        const bad = await fetch(`${base}/api/reviews/${r.reviewId}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'deepseek',
            model: 'deepseek-v4-flash',
            consent: { ...baseConsent, contentHash: 'f'.repeat(64) },
          }),
        });
        expect(bad.status).toBe(422);
        expect(sent).toHaveLength(0);

        // Correct hash → 200, key-free receipt, request carried the key only in the header.
        const good = await fetch(`${base}/api/reviews/${r.reviewId}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'deepseek',
            model: 'deepseek-v4-flash',
            consent: { ...baseConsent, contentHash: est.contentHash },
          }),
        });
        expect(good.status).toBe(200);
        const raw = await good.text();
        expect(raw).not.toContain(FAKE_KEY); // receipt is key-free
        const body = JSON.parse(raw) as { receipt: { backstopPassed: boolean; usage: unknown } };
        expect(body.receipt.backstopPassed).toBe(true);
        expect(body.receipt.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

        expect(sent).toHaveLength(1);
        expect(sent[0].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
        expect(sent[0].body).not.toContain(FAKE_KEY);
      },
    );
  });
});
