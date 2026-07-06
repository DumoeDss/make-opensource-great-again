import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, rm, withServer } from './_helpers.js';

describe('same-origin static UI serving', () => {
  let dist: string;

  beforeEach(() => {
    dist = makeTempDir('mosga-ui-dist-');
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      '<!doctype html><html><body><div id="root">mosga review ui</div></body></html>',
      'utf-8',
    );
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("mosga")', 'utf-8');
  });

  afterEach(() => rm(dist));

  it('serves the built UI at /ui and the API on the same origin', async () => {
    await withServer({ getUiDist: () => dist }, async (base) => {
      const ui = await fetch(`${base}/ui/`);
      expect(ui.status).toBe(200);
      expect(ui.headers.get('content-type')).toContain('text/html');
      expect(await ui.text()).toContain('mosga review ui');

      const asset = await fetch(`${base}/ui/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('javascript');

      // Same origin as the API.
      const api = await fetch(`${base}/api/health`);
      expect(api.status).toBe(200);
    });
  });

  it('reports a clear error when the UI dist is missing', async () => {
    await withServer({ getUiDist: () => null }, async (base) => {
      const res = await fetch(`${base}/ui/`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('@mosga/ui build was not found');
    });
  });
});
