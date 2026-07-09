/**
 * providerStore.test.ts — user-scope custom-provider + encrypted-key persistence
 * (tasks 4.5). No network; a temp home dir per test.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserTarget } from '@mosga/direct-submit';

import { createProviderStore, ProviderConflictError } from '../providerStore.js';
import { isEnvelope } from '../secrets/index.js';
import { makeTempDir, rm } from './_helpers.js';

const FAKE_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

function target(over: Partial<UserTarget> = {}): UserTarget {
  return {
    id: 'my-llm',
    name: 'My LLM',
    apiFormat: 'openai',
    apiBaseUrl: 'https://api.example.com/v1/chat/completions',
    models: ['m-1'],
    ...over,
  };
}

describe('providerStore', () => {
  let home: string;

  beforeEach(() => {
    home = makeTempDir('mosga-store-');
  });

  afterEach(() => {
    rm(home);
  });

  it('creates, lists, updates, and deletes custom providers, persisting across reloads', () => {
    const store = createProviderStore({ homeDir: home });
    store.createCustomProvider(target());
    expect(store.listCustomProviders().map((p) => p.id)).toEqual(['my-llm']);

    // A fresh store reads the same file back.
    const reloaded = createProviderStore({ homeDir: home });
    expect(reloaded.listCustomProviders()).toHaveLength(1);

    reloaded.updateCustomProvider('my-llm', {
      name: 'Renamed',
      apiFormat: 'gemini',
      apiBaseUrl: 'https://g.example.com',
      models: ['g-1', 'g-2'],
    });
    const after = createProviderStore({ homeDir: home });
    const p = after.listCustomProviders()[0];
    expect(p.name).toBe('Renamed');
    expect(p.apiFormat).toBe('gemini');
    expect(p.models).toEqual(['g-1', 'g-2']);

    expect(after.deleteCustomProvider('my-llm')).toBe(true);
    expect(createProviderStore({ homeDir: home }).listCustomProviders()).toHaveLength(0);
  });

  it('rejects a duplicate custom-provider id', () => {
    const store = createProviderStore({ homeDir: home });
    store.createCustomProvider(target());
    expect(() => store.createCustomProvider(target())).toThrow(ProviderConflictError);
  });

  it('never persists a key field on a custom provider record', () => {
    const store = createProviderStore({ homeDir: home });
    store.createCustomProvider({ ...target(), ...({ apiKey: FAKE_KEY } as object) } as UserTarget);
    const raw = fs.readFileSync(path.join(home, '.mosga', 'user-providers.json'), 'utf-8');
    // The record shape is id/name/apiFormat/apiBaseUrl/models; even if a caller
    // passed extra fields they must never contain the key value on disk.
    expect(raw).not.toContain(FAKE_KEY);
  });

  it('stores a set key as an enc: envelope and resolves it back to plaintext', () => {
    const store = createProviderStore({ homeDir: home });
    store.setKey('deepseek', FAKE_KEY);

    const keysFile = path.join(home, '.mosga', 'provider-keys.json');
    const onDisk = JSON.parse(fs.readFileSync(keysFile, 'utf-8')) as Record<string, string>;
    expect(isEnvelope(onDisk.deepseek)).toBe(true);
    expect(onDisk.deepseek).not.toContain(FAKE_KEY); // raw key never on disk

    // A fresh store (same home → same keyfile) decrypts it back.
    const reloaded = createProviderStore({ homeDir: home });
    expect(reloaded.getKey('deepseek')).toBe(FAKE_KEY);
    expect(reloaded.keyStatus()).toEqual({ deepseek: { configured: true } });
  });

  it('passes a $ENV indirection and legacy plaintext through on read', () => {
    const store = createProviderStore({ homeDir: home });
    // Seed the keys file by hand with an env-ref + legacy plaintext value.
    fs.mkdirSync(path.join(home, '.mosga'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.mosga', 'provider-keys.json'),
      JSON.stringify({ a: '$SOME_ENV', b: 'legacy-plain' }),
      'utf-8',
    );
    const reloaded = createProviderStore({ homeDir: home });
    expect(reloaded.getKey('a')).toBe('$SOME_ENV');
    expect(reloaded.getKey('b')).toBe('legacy-plain');
    void store;
  });

  it('deletes a key and reports configured:false', () => {
    const store = createProviderStore({ homeDir: home });
    store.setKey('deepseek', FAKE_KEY);
    expect(store.deleteKey('deepseek')).toBe(true);
    expect(store.getKey('deepseek')).toBeUndefined();
    expect(store.keyStatus().deepseek).toBeUndefined();
    expect(store.deleteKey('deepseek')).toBe(false);
  });

  it('merges injected targets first, then persisted, deduped by id (injected wins)', () => {
    const store = createProviderStore({ homeDir: home });
    store.createCustomProvider(target({ id: 'shared', name: 'Persisted' }));
    store.createCustomProvider(target({ id: 'only-persisted' }));

    const injected: UserTarget[] = [target({ id: 'shared', name: 'Injected' })];
    const merged = store.mergedTargets(injected);
    expect(merged.map((t) => t.id)).toEqual(['shared', 'only-persisted']);
    expect(merged.find((t) => t.id === 'shared')!.name).toBe('Injected'); // injected wins
  });

  it('treats a missing or corrupt file as empty and never throws', () => {
    // No files written yet.
    const store = createProviderStore({ homeDir: home });
    expect(store.listCustomProviders()).toEqual([]);
    expect(store.keyStatus()).toEqual({});

    // Corrupt both files.
    fs.mkdirSync(path.join(home, '.mosga'), { recursive: true });
    fs.writeFileSync(path.join(home, '.mosga', 'user-providers.json'), '{ not json', 'utf-8');
    fs.writeFileSync(path.join(home, '.mosga', 'provider-keys.json'), 'nonsense', 'utf-8');
    const store2 = createProviderStore({ homeDir: home });
    expect(store2.listCustomProviders()).toEqual([]);
    expect(store2.keyStatus()).toEqual({});
  });
});
