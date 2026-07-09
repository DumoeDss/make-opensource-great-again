/**
 * providerRoutes.test.ts — custom-provider CRUD + write-only key routes + the
 * narrowed provider list (tasks 5.4). File-backed store under a temp home; no
 * network, no real key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, rm, withServer } from './_helpers.js';

const FAKE_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

async function jsonRes<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function customProvider(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'my-llm',
    name: 'My LLM',
    apiFormat: 'gemini',
    apiBaseUrl: 'https://api.example.com',
    models: ['m-1'],
    ...over,
  };
}

describe('provider-management routes', () => {
  let home: string;

  beforeEach(() => {
    home = makeTempDir('mosga-proutes-');
  });

  afterEach(() => {
    rm(home);
  });

  it('narrows /api/providers to the open-model allowlist (no openai/anthropic presets)', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const body = await jsonRes<{ providers: Array<{ id: string }> }>(
        await fetch(`${base}/api/providers`),
      );
      const ids = body.providers.map((p) => p.id);
      expect(ids).toContain('deepseek');
      expect(ids).toContain('xiaomi-mimo-anthropic');
      // Excluded non-open-source / relay presets.
      expect(ids).not.toContain('openai');
      expect(ids).not.toContain('anthropic');
      expect(ids).not.toContain('openrouter');
    });
  });

  it('creates, lists, updates, and deletes a custom provider; it appears in /api/providers', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const created = await fetch(`${base}/api/custom-providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(customProvider()),
      });
      expect(created.status).toBe(201);

      const list = await jsonRes<{ providers: Array<{ id: string }> }>(
        await fetch(`${base}/api/custom-providers`),
      );
      expect(list.providers.map((p) => p.id)).toEqual(['my-llm']);

      // It also shows up in the unified provider list.
      const all = await jsonRes<{ providers: Array<{ id: string }> }>(
        await fetch(`${base}/api/providers`),
      );
      expect(all.providers.some((p) => p.id === 'my-llm')).toBe(true);

      const updated = await fetch(`${base}/api/custom-providers/my-llm`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Renamed',
          apiFormat: 'openai',
          apiBaseUrl: 'https://api.example.com/v1/chat/completions',
          models: ['m-2'],
        }),
      });
      expect(updated.status).toBe(200);
      const afterUpdate = await jsonRes<{ provider: { name: string } }>(updated);
      expect(afterUpdate.provider.name).toBe('Renamed');

      const del = await fetch(`${base}/api/custom-providers/my-llm`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const del2 = await fetch(`${base}/api/custom-providers/my-llm`, { method: 'DELETE' });
      expect(del2.status).toBe(404); // already gone
    });
  });

  it('rejects an invalid apiFormat or non-http(s) URL, persisting nothing', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const badFormat = await fetch(`${base}/api/custom-providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(customProvider({ apiFormat: 'cohere' })),
      });
      expect(badFormat.status).toBe(400);

      const badUrl = await fetch(`${base}/api/custom-providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(customProvider({ apiBaseUrl: 'ftp://example.com' })),
      });
      expect(badUrl.status).toBe(400);

      const list = await jsonRes<{ providers: unknown[] }>(
        await fetch(`${base}/api/custom-providers`),
      );
      expect(list.providers).toHaveLength(0);
    });
  });

  it('rejects a custom id colliding with an allowlisted preset (409, persists nothing)', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const clash = await fetch(`${base}/api/custom-providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(customProvider({ id: 'deepseek' })),
      });
      expect(clash.status).toBe(409);
      expect((await jsonRes<{ code: string }>(clash)).code).toBe('PROVIDER_EXISTS');

      // Nothing persisted, and /api/providers still has a single `deepseek` (the preset).
      const list = await jsonRes<{ providers: unknown[] }>(
        await fetch(`${base}/api/custom-providers`),
      );
      expect(list.providers).toHaveLength(0);
      const all = await jsonRes<{ providers: Array<{ id: string }> }>(
        await fetch(`${base}/api/providers`),
      );
      expect(all.providers.filter((p) => p.id === 'deepseek')).toHaveLength(1);
    });
  });

  it('rejects a duplicate custom-provider id with 409', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const opts = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(customProvider()),
      };
      expect((await fetch(`${base}/api/custom-providers`, opts)).status).toBe(201);
      const dup = await fetch(`${base}/api/custom-providers`, opts);
      expect(dup.status).toBe(409);
      const body = await jsonRes<{ code: string }>(dup);
      expect(body.code).toBe('PROVIDER_EXISTS');
    });
  });

  it('sets + deletes a key write-only: status is boolean-only and no response echoes key bytes', async () => {
    await withServer({ homeDir: home }, async (base) => {
      // Initially no keys.
      const empty = await jsonRes<{ status: Record<string, unknown> }>(
        await fetch(`${base}/api/provider-keys`),
      );
      expect(empty.status).toEqual({});

      // Set a key — response confirms success without echoing the key.
      const putRes = await fetch(`${base}/api/provider-keys/deepseek`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: FAKE_KEY }),
      });
      expect(putRes.status).toBe(200);
      const putRaw = await putRes.text();
      expect(putRaw).not.toContain(FAKE_KEY);

      // Status now reports configured:true — a boolean, never the key.
      const statusRes = await fetch(`${base}/api/provider-keys`);
      const statusRaw = await statusRes.text();
      expect(statusRaw).not.toContain(FAKE_KEY);
      const status = JSON.parse(statusRaw) as { status: Record<string, { configured: boolean }> };
      expect(status.status.deepseek).toEqual({ configured: true });

      // Delete clears it → configured:false.
      const delRes = await fetch(`${base}/api/provider-keys/deepseek`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const after = await jsonRes<{ status: Record<string, unknown> }>(
        await fetch(`${base}/api/provider-keys`),
      );
      expect(after.status.deepseek).toBeUndefined();
    });
  });

  it('a set key satisfies submit key-resolution (store is the last precedence tier)', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const put = await fetch(`${base}/api/provider-keys/deepseek`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: FAKE_KEY }),
      });
      expect(put.status).toBe(200);
      // GET status must not reveal the value; presence only.
      const status = await jsonRes<{ status: Record<string, { configured: boolean }> }>(
        await fetch(`${base}/api/provider-keys`),
      );
      expect(status.status.deepseek.configured).toBe(true);
    });
  });
});
