import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isLoopbackHost } from '../app.js';
import {
  PublicationError,
  type GitHubPublication,
} from '../publication/index.js';
import { DEFAULT_MAX_REVIEWS } from '../reviews.js';
import { FAKE_AWS_KEY, makeTempDir, rm, secretTurn, withServer, writeSession } from './_helpers.js';

/** Raw HTTP GET that can set an arbitrary Host header (fetch forbids it). */
function rawGet(
  port: number,
  reqPath: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        setHost: host !== undefined,
        headers: host === undefined ? {} : { host },
      },
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

function rawHttp10WithoutHost(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host: '127.0.0.1', port },
      () => socket.write('GET /api/health HTTP/1.0\r\n\r\n'),
    );
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => {
      const match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(response);
      if (!match) {
        reject(new Error('invalid raw HTTP response'));
        return;
      }
      resolve(Number(match[1]));
    });
    socket.on('error', reject);
  });
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

      expect(await rawHttp10WithoutHost(daemon.port)).toBe(403);
    });
  });

  it('isLoopbackHost accepts only loopback names', () => {
    expect(isLoopbackHost('127.0.0.1:8899')).toBe(true);
    expect(isLoopbackHost('localhost:8899')).toBe(true);
    expect(isLoopbackHost('[::1]:8899')).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('evil.example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('169.254.1.1')).toBe(false);
    expect(isLoopbackHost('localhost:not-a-port')).toBe(false);
    expect(isLoopbackHost('127.0.0.1:0')).toBe(false);
    expect(isLoopbackHost('[::1]:65536')).toBe(false);
  });

  // MINOR M-3: /preview must not return the raw text of still-pending findings.
  it('redacts pending blocking findings in the preview session', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const reviewId = await createReview(base);
      const preview = (await (
        await fetch(`${base}/api/reviews/${reviewId}/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        })
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

  it('requires same-origin JSON for every mutating route family and sends no CORS headers', async () => {
    const configure = vi.fn(async () => ({ state: 'unconfigured' as const, revision: 1 }));
    const publication: GitHubPublication = {
      inspect: async () => ({ state: 'unconfigured', revision: 0 }),
      configure,
      clear: async () => ({ state: 'unconfigured', revision: 2 }),
      preview: async () => {
        throw new Error('route should not be reached');
      },
      submit: async () => {
        throw new Error('route should not be reached');
      },
    };
    await withServer({ homeDir: home, publication }, async (base) => {
      const nonJsonPaths: Array<[string, string]> = [
        ['POST', '/api/reviews'],
        ['POST', '/api/reviews/missing/submit'],
        ['PUT', '/api/provider-keys/provider'],
        ['PUT', '/api/publish/target'],
        ['DELETE', '/api/publish/target'],
        ['POST', '/api/publish/preview'],
        ['POST', '/api/publish/submit'],
      ];
      for (const [method, route] of nonJsonPaths) {
        const response = await fetch(`${base}${route}`, { method });
        expect(response.status, `${method} ${route}`).toBe(415);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }

      const matching = await fetch(`${base}/api/publish/target`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          origin: base,
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ repository: 'owner/repo' }),
      });
      expect(matching.status).toBe(200);
      expect(configure).toHaveBeenCalledOnce();

      for (const headers of [
        { origin: 'null' },
        { origin: `${base}0` },
        { origin: base.replace('http:', 'https:') },
        { 'sec-fetch-site': 'cross-site' },
      ]) {
        const response = await fetch(`${base}/api/publish/target`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            ...headers,
          },
          body: JSON.stringify({ repository: 'owner/repo' }),
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
      }
      expect(configure).toHaveBeenCalledOnce();
    });
  });

  it('never serializes sensitive unexpected or publication error text', async () => {
    const sensitive =
      'ghp_FAKE C:\\Users\\alice\\private git push stdout=LEAK stderr=LEAK';
    const methods = {
      configure: async () => ({ state: 'unconfigured' as const, revision: 0 }),
      clear: async () => ({ state: 'unconfigured' as const, revision: 0 }),
      preview: async () => {
        throw new Error(sensitive);
      },
      submit: async () => {
        throw new Error(sensitive);
      },
    };
    const unexpected: GitHubPublication = {
      inspect: async () => {
        throw new Error(sensitive);
      },
      ...methods,
    };
    await withServer({ publication: unexpected }, async (base) => {
      const response = await fetch(`${base}/api/publish`);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('INTERNAL_ERROR');
      for (const canary of ['ghp_FAKE', 'C:\\Users', 'git push', 'stdout', 'stderr']) {
        expect(body).not.toContain(canary);
      }
    });

    const known: GitHubPublication = {
      inspect: async () => {
        throw new PublicationError({
          code: 'github_unavailable',
          phase: 'target',
          message: sensitive,
          retryable: true,
          recovery: sensitive,
          gate: { sensitive },
        });
      },
      ...methods,
    };
    await withServer({ publication: known }, async (base) => {
      const response = await fetch(`${base}/api/publish`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain('GitHub is temporarily unavailable.');
      for (const canary of ['ghp_FAKE', 'C:\\Users', 'git push', 'stdout', 'stderr']) {
        expect(body).not.toContain(canary);
      }
    });
  });
});
