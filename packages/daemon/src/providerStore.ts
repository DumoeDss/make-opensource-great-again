/**
 * providerStore.ts — user-scope persistence for custom provider targets and
 * provider API keys, behind a small injectable interface (mirroring how
 * `publish.ts` isolates its concern). `createApp` wires a file-backed store;
 * tests inject an in-memory fake so no disk or real key is touched.
 *
 * Two files under the user-scope dir (default `~/.mosga/`):
 *  - `user-providers.json` — an array of `UserTarget` (`id/name/apiFormat/
 *    apiBaseUrl/models`), NEVER a key.
 *  - `provider-keys.json` — a `{ providerId: value }` map, created `0600`, whose
 *    values are ENCRYPTED AT REST: every value passes through `SecretBox`
 *    (`encryptMaybe` on write → an `enc:v1:` envelope; `decryptMaybe` on read,
 *    so a hand-authored `$ENV` indirection or a legacy plaintext value still
 *    resolves). No route ever returns key bytes (plaintext or ciphertext).
 *
 * Both files are written atomically (temp + rename) and an unreadable/missing
 * file is treated as empty (never throws to a caller). The master key backing
 * the SecretBox is resolved LAZILY (a store that only reads a legacy-plaintext
 * key or is never touched for a key never materializes a keyfile).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { UserTarget } from '@mosga/direct-submit';

import { resolveMasterKey, SecretBox } from './secrets/index.js';

/** Per-provider key status — the ONLY key-shaped data any route may return. */
export interface KeyStatus {
  configured: boolean;
}

/** Raised when creating a custom provider whose id already exists. */
export class ProviderConflictError extends Error {
  constructor(id: string) {
    super(`a custom provider with id "${id}" already exists`);
    this.name = 'ProviderConflictError';
  }
}

/**
 * The injectable persistence surface. The file-backed implementation
 * (`createProviderStore`) and the test fake both satisfy it.
 */
export interface ProviderStore {
  /** All persisted custom providers (key-free records). */
  listCustomProviders(): UserTarget[];
  /** Create a custom provider; throws `ProviderConflictError` on id collision. */
  createCustomProvider(target: UserTarget): UserTarget;
  /** Update an existing custom provider's fields; `undefined` if it is unknown. */
  updateCustomProvider(id: string, fields: Omit<UserTarget, 'id'>): UserTarget | undefined;
  /** Delete a custom provider; `false` if it was not present. */
  deleteCustomProvider(id: string): boolean;
  /**
   * The provider targets to expose: injected (startup/test) targets first, then
   * persisted custom providers, deduped by id with injected winning — so
   * injected `userTargets` stay authoritative and daemon tests are deterministic.
   */
  mergedTargets(injected: UserTarget[]): UserTarget[];
  /** Persist a key for a provider (encrypted at rest via `encryptMaybe`). */
  setKey(providerId: string, apiKey: string): void;
  /** Remove a provider's key; `false` if none was set. */
  deleteKey(providerId: string): boolean;
  /** Resolve a provider's stored key to plaintext (via `decryptMaybe`), if any. */
  getKey(providerId: string): string | undefined;
  /** The per-provider `configured` status map — never any key bytes. */
  keyStatus(): Record<string, KeyStatus>;
}

export interface ProviderStoreOptions {
  /** Path to the custom-providers file. Default `~/.mosga/user-providers.json`. */
  userProvidersPath?: string;
  /** Path to the encrypted key store. Default `~/.mosga/provider-keys.json`. */
  keysPath?: string;
  /** Path to the master keyfile backing the SecretBox. Default `~/.mosga/master.key`. */
  masterKeyFilePath?: string;
  /** Home dir the defaults resolve under. Defaults to `os.homedir()`. */
  homeDir?: string;
}

function mosgaDir(homeDir: string): string {
  return path.join(homeDir, '.mosga');
}

/**
 * Normalize a target to EXACTLY the key-free `UserTarget` shape — drops any
 * extra field a caller might have passed (defense in depth; the routes already
 * zod-strip, but the store never persists a stray `apiKey`-like field).
 */
function pickTarget(t: UserTarget): UserTarget {
  return {
    id: t.id,
    name: t.name,
    apiFormat: t.apiFormat,
    apiBaseUrl: t.apiBaseUrl,
    models: Array.isArray(t.models) ? [...t.models] : [],
  };
}

/** Read + JSON-parse a file, returning `undefined` for any missing/unreadable/invalid file. */
function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    // Missing/unreadable/invalid → treat as empty; never surfaced to a caller.
    return undefined;
  }
}

/** Atomically write `content` to `filePath` (temp + rename), mkdir-ing the parent. */
function atomicWrite(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      // Non-POSIX filesystems may reject chmod; the write itself succeeded.
    }
  }
  fs.renameSync(tmp, filePath);
}

/**
 * The file-backed store. Loads both files into memory at construction; every
 * mutation rewrites the backing file atomically. Key values are encrypted at
 * rest via a lazily-resolved `SecretBox`.
 */
export function createProviderStore(options: ProviderStoreOptions = {}): ProviderStore {
  const homeDir = options.homeDir ?? os.homedir();
  const userProvidersPath = options.userProvidersPath ?? path.join(mosgaDir(homeDir), 'user-providers.json');
  const keysPath = options.keysPath ?? path.join(mosgaDir(homeDir), 'provider-keys.json');
  const masterKeyFilePath = options.masterKeyFilePath ?? path.join(mosgaDir(homeDir), 'master.key');

  // Lazy: the key is only resolved (and a keyfile materialized) when a value is
  // actually encrypted or an `enc:` value decrypted.
  const box = new SecretBox(() => resolveMasterKey({ keyFilePath: masterKeyFilePath }));

  // ---- in-memory caches, loaded once ----
  const rawProviders = readJsonFile(userProvidersPath);
  const providers: UserTarget[] = Array.isArray(rawProviders)
    ? (rawProviders as UserTarget[]).map(pickTarget)
    : [];

  const rawKeys = readJsonFile(keysPath);
  const keys: Record<string, string> =
    rawKeys && typeof rawKeys === 'object' && !Array.isArray(rawKeys)
      ? (rawKeys as Record<string, string>)
      : {};

  function persistProviders(): void {
    atomicWrite(userProvidersPath, JSON.stringify(providers, null, 2));
  }

  function persistKeys(): void {
    atomicWrite(keysPath, JSON.stringify(keys, null, 2), 0o600);
  }

  return {
    listCustomProviders() {
      return providers.map((p) => ({ ...p }));
    },

    createCustomProvider(target) {
      if (providers.some((p) => p.id === target.id)) {
        throw new ProviderConflictError(target.id);
      }
      const clean = pickTarget(target);
      providers.push(clean);
      persistProviders();
      return { ...clean };
    },

    updateCustomProvider(id, fields) {
      const idx = providers.findIndex((p) => p.id === id);
      if (idx < 0) return undefined;
      const updated = pickTarget({ ...fields, id });
      providers[idx] = updated;
      persistProviders();
      return { ...updated };
    },

    deleteCustomProvider(id) {
      const idx = providers.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      providers.splice(idx, 1);
      persistProviders();
      return true;
    },

    mergedTargets(injected) {
      const seen = new Set(injected.map((t) => t.id));
      const merged = [...injected];
      for (const p of providers) {
        if (!seen.has(p.id)) merged.push({ ...p });
      }
      return merged;
    },

    setKey(providerId, apiKey) {
      keys[providerId] = box.encryptMaybe(apiKey);
      persistKeys();
    },

    deleteKey(providerId) {
      if (!(providerId in keys)) return false;
      delete keys[providerId];
      persistKeys();
      return true;
    },

    getKey(providerId) {
      const value = keys[providerId];
      if (typeof value !== 'string' || value.length === 0) return undefined;
      try {
        return box.decryptMaybe(value);
      } catch {
        // A lost/rotated master key or a tampered `enc:` envelope fails GCM
        // verification and `decryptMaybe` throws. Treat an undecryptable entry as
        // "no stored key" (secret-free) so the env/startup tiers and
        // `KeyNotConfiguredError` still apply, rather than 500-ing the submit. The
        // thrown error carries no key bytes, so swallowing it leaks nothing.
        return undefined;
      }
    },

    keyStatus() {
      const status: Record<string, KeyStatus> = {};
      for (const [id, value] of Object.entries(keys)) {
        status[id] = { configured: typeof value === 'string' && value.length > 0 };
      }
      return status;
    },
  };
}

/**
 * An in-memory `ProviderStore` for tests — same semantics, no disk, no crypto
 * (keys are held plaintext in memory; the file-backed store owns encryption).
 */
export function createInMemoryProviderStore(seed?: {
  providers?: UserTarget[];
  keys?: Record<string, string>;
}): ProviderStore {
  const providers: UserTarget[] = seed?.providers ? seed.providers.map((p) => ({ ...p })) : [];
  const keys: Record<string, string> = { ...(seed?.keys ?? {}) };

  return {
    listCustomProviders() {
      return providers.map((p) => ({ ...p }));
    },
    createCustomProvider(target) {
      if (providers.some((p) => p.id === target.id)) throw new ProviderConflictError(target.id);
      providers.push({ ...target });
      return { ...target };
    },
    updateCustomProvider(id, fields) {
      const idx = providers.findIndex((p) => p.id === id);
      if (idx < 0) return undefined;
      const updated: UserTarget = { ...fields, id };
      providers[idx] = updated;
      return { ...updated };
    },
    deleteCustomProvider(id) {
      const idx = providers.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      providers.splice(idx, 1);
      return true;
    },
    mergedTargets(injected) {
      const seen = new Set(injected.map((t) => t.id));
      const merged = [...injected];
      for (const p of providers) if (!seen.has(p.id)) merged.push({ ...p });
      return merged;
    },
    setKey(providerId, apiKey) {
      keys[providerId] = apiKey;
    },
    deleteKey(providerId) {
      if (!(providerId in keys)) return false;
      delete keys[providerId];
      return true;
    },
    getKey(providerId) {
      const value = keys[providerId];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    },
    keyStatus() {
      const status: Record<string, KeyStatus> = {};
      for (const [id, value] of Object.entries(keys)) {
        status[id] = { configured: typeof value === 'string' && value.length > 0 };
      }
      return status;
    },
  };
}
