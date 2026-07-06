import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLoopbackHost } from '../app.js';
import { DEFAULT_MAX_REVIEWS } from '../reviews.js';
import { FAKE_AWS_KEY, makeTempDir, rm, secretTurn, withServer, writeSession } from './_helpers.js';

/** Raw HTTP GET that can set an arbitrary Host header (fetch forbids it). */
function rawGet(
  port: number,
  reqPath: string,
  host: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function createReview(base: string): Promise<string> {
  const res = await fetch(`${base}/api/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'claude-code', projectKey: 'projX', sessionId: 'sess-x' }),
  });
  return ((await res.json()) as { reviewId: string }).reviewId;
}

describe('daemon security hardening', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    writeSession(home, 'projX', 'sess-x', cwd, [secretTurn('u1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
  });

  // MAJOR: a client-supplied customRulesPath must NOT be read, and no bytes of an
  // arbitrary file may appear in any response body.
  it('ignores a client customRulesPath and never leaks the file contents', async () => {
    const marker = 'CANARY_FILE_CONTENT_AKIA_DO_NOT_LEAK';
    const secretFile = path.join(os.tmpdir(), `mosga-canary-${Date.now()}.txt`);
    fs.writeFileSync(secretFile, `${marker} not-json {{{`, 'utf-8');
    try {
      await withServer({ homeDir: home }, async (base) => {
        for (const candidate of [secretFile, '../../../../etc/passwd', `..${path.sep}${path.basename(secretFile)}`]) {
          const res = await fetch(`${base}/api/reviews`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceId: 'claude-code',
              projectKey: 'projX',
              sessionId: 'sess-x',
              customRulesPath: candidate,
            }),
          });
          // The unknown field is stripped by validation; the review is created
          // normally and no file read occurs.
          expect(res.status).toBe(201);
          expect(JSON.stringify(await res.json())).not.toContain(marker);
        }
      });
    } finally {
      fs.rmSync(secretFile, { force: true });
    }
  });

  // MINOR M-2: reject non-loopback Host headers (DNS-rebinding guard).
  it('rejects a non-loopback Host header with 403 but allows loopback', async () => {
    await withServer({ homeDir: home }, async (_base, daemon) => {
      const evil = await rawGet(daemon.port, '/api/health', 'evil.example.com');
      expect(evil.status).toBe(403);
      expect(evil.body).not.toContain('mosga-daemon');

      const loopbackIp = await rawGet(daemon.port, '/api/health', `127.0.0.1:${daemon.port}`);
      expect(loopbackIp.status).toBe(200);
      expect(loopbackIp.body).toContain('mosga-daemon');

      const localhost = await rawGet(daemon.port, '/api/health', `localhost:${daemon.port}`);
      expect(localhost.status).toBe(200);
    });
  });

  it('isLoopbackHost accepts only loopback names', () => {
    expect(isLoopbackHost('127.0.0.1:8899')).toBe(true);
    expect(isLoopbackHost('localhost:8899')).toBe(true);
    expect(isLoopbackHost('[::1]:8899')).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost('evil.example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('169.254.1.1')).toBe(false);
  });

  // MINOR M-3: /preview must not return the raw text of still-pending findings.
  it('redacts pending blocking findings in the preview session', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const reviewId = await createReview(base);
      const preview = (await (
        await fetch(`${base}/api/reviews/${reviewId}/preview`, { method: 'POST' })
      ).json()) as { session: unknown; stamped: boolean };
      const text = JSON.stringify(preview.session);
      expect(text).not.toContain(FAKE_AWS_KEY);
      expect(text).toContain('<PENDING:');
      expect(preview.stamped).toBe(false);
    });
  });

  // MINOR M-4: the review store evicts beyond its cap, keeping touched entries warm.
  it('evicts the least-recently-used review beyond the cap', async () => {
    await withServer({ homeDir: home, maxReviews: 2 }, async (base) => {
      const first = await createReview(base);
      const second = await createReview(base);
      // Touch `first` so it is most-recently-used; `second` becomes the LRU.
      expect((await fetch(`${base}/api/reviews/${first}`)).status).toBe(200);
      const third = await createReview(base);

      expect((await fetch(`${base}/api/reviews/${second}`)).status).toBe(404);
      expect((await fetch(`${base}/api/reviews/${first}`)).status).toBe(200);
      expect((await fetch(`${base}/api/reviews/${third}`)).status).toBe(200);
    });
  });

  it('exposes a sane default review cap', () => {
    expect(DEFAULT_MAX_REVIEWS).toBeGreaterThan(0);
  });
});
