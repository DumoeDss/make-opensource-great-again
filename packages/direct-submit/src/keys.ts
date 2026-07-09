import { existsSync, readFileSync } from 'node:fs';

/**
 * Raised when no API key is configured for the chosen provider. This is a
 * CONFIGURATION error, not a leak — it echoes no partial credential and sends
 * nothing. Maps to a clear error at the daemon boundary.
 */
export class KeyNotConfiguredError extends Error {
  constructor(providerId: string) {
    super(
      `no API key configured for provider "${providerId}"; set MOSGA_PROVIDER_KEY_${envSuffix(providerId)} ` +
        `or MOSGA_PROVIDER_KEY, or add it to the trusted local key config. Nothing was sent.`,
    );
    this.name = 'KeyNotConfiguredError';
  }
}

function envSuffix(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export interface KeyResolutionOptions {
  /** Environment map to read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Path to a TRUSTED local JSON config mapping providerId -> key. Loaded from
   * server-side config only (a flag/env), NEVER a request body or a
   * client-supplied path — same trust model as the daemon's `customRulesPath`.
   */
  keyConfigPath?: string;
  /**
   * Lowest-precedence lookup into the user-scope, HTTP-writable key store
   * (decrypted server-side by the store). Consulted ONLY after env and the
   * trusted startup `keyConfigPath` — so explicit operator config always
   * outranks a UI-written key. Returns the plaintext key or `undefined`.
   */
  storeKeyLookup?: (providerId: string) => string | undefined;
}

/**
 * Resolve the contributor's own provider key SERVER-SIDE. Precedence:
 * per-provider env (`MOSGA_PROVIDER_KEY_<ID>`) → generic env
 * (`MOSGA_PROVIDER_KEY`) → trusted startup key config file → user-scope key
 * store (the HTTP-written store, decrypted; lowest precedence). Returns
 * `undefined` when nothing is configured (caller raises `KeyNotConfiguredError`).
 * The key is used ONLY as the outbound authorization header and never enters any
 * serialized output.
 */
export function resolveProviderKey(
  providerId: string,
  options: KeyResolutionOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const perProvider = env[`MOSGA_PROVIDER_KEY_${envSuffix(providerId)}`];
  if (perProvider && perProvider.length > 0) return perProvider;
  const generic = env['MOSGA_PROVIDER_KEY'];
  if (generic && generic.length > 0) return generic;

  if (options.keyConfigPath && existsSync(options.keyConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(options.keyConfigPath, 'utf-8')) as Record<string, unknown>;
      const value = parsed[providerId];
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // An unreadable/invalid key config is treated as "no key" — never surfaced
      // to a client, and never a partial-credential leak.
    }
  }

  // LAST tier: the HTTP-written user-scope store (a missing/unreadable store, or
  // an entry that fails to decrypt with a lost/rotated master key, is "no key";
  // the store swallows its own read/decrypt errors and never throws here).
  if (options.storeKeyLookup) {
    const stored = options.storeKeyLookup(providerId);
    if (stored && stored.length > 0) return stored;
  }
  return undefined;
}
