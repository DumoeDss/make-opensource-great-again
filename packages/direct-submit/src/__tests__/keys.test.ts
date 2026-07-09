import { describe, expect, it, vi } from 'vitest';

import { KeyNotConfiguredError, resolveProviderKey } from '../keys.js';
import { resolveProvider } from '../providers.js';
import { submit } from '../submit.js';
import {
  FAKE_PROVIDER_KEY,
  RULESET,
  VERSIONS,
  cleanSession,
  makeConsent,
  recordingTransport,
} from './_fixtures.js';

const target = resolveProvider('deepseek')!;

describe('key resolution (server-side only)', () => {
  it('reads the per-provider env var, then the generic, then the config file', () => {
    expect(
      resolveProviderKey('deepseek', { env: { MOSGA_PROVIDER_KEY_DEEPSEEK: FAKE_PROVIDER_KEY } }),
    ).toBe(FAKE_PROVIDER_KEY);
    expect(resolveProviderKey('deepseek', { env: { MOSGA_PROVIDER_KEY: 'generic' } })).toBe('generic');
    expect(resolveProviderKey('deepseek', { env: {} })).toBeUndefined();
  });

  it('consults the store LAST — env and startup config both outrank it', () => {
    const store = (id: string): string | undefined => (id === 'deepseek' ? 'from-store' : undefined);
    // Store is used only when nothing higher is configured.
    expect(resolveProviderKey('deepseek', { env: {}, storeKeyLookup: store })).toBe('from-store');
    // Per-provider env outranks the store.
    expect(
      resolveProviderKey('deepseek', {
        env: { MOSGA_PROVIDER_KEY_DEEPSEEK: FAKE_PROVIDER_KEY },
        storeKeyLookup: store,
      }),
    ).toBe(FAKE_PROVIDER_KEY);
    // Generic env outranks the store.
    expect(
      resolveProviderKey('deepseek', { env: { MOSGA_PROVIDER_KEY: 'generic' }, storeKeyLookup: store }),
    ).toBe('generic');
    // No store hit → undefined.
    expect(resolveProviderKey('unknown', { env: {}, storeKeyLookup: store })).toBeUndefined();
  });

  it('a missing key is a configuration error, not a leak', async () => {
    const { transport, requests } = recordingTransport();
    const session = cleanSession();
    await expect(
      submit({
        session,
        target,
        model: 'deepseek-v4-flash',
        consent: makeConsent(session),
        ruleset: RULESET,
        apiKey: undefined,
        transport,
        versions: VERSIONS,
      }),
    ).rejects.toBeInstanceOf(KeyNotConfiguredError);
    expect(requests).toHaveLength(0);
  });
});

describe('key never leaks into any serialized output or log', () => {
  it('appears only in the outbound authorization header', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
    try {
      const session = cleanSession();
      const consent = makeConsent(session);
      const { transport, requests } = recordingTransport();
      const receipt = await submit({
        session,
        target,
        model: 'deepseek-v4-flash',
        consent,
        ruleset: RULESET,
        apiKey: FAKE_PROVIDER_KEY,
        transport,
        versions: VERSIONS,
      });

      // Present ONLY in the auth header.
      expect(requests[0].headers.authorization).toBe(`Bearer ${FAKE_PROVIDER_KEY}`);
      // Absent from the request body, the receipt, the consent, and logs.
      expect(requests[0].body).not.toContain(FAKE_PROVIDER_KEY);
      expect(JSON.stringify(receipt)).not.toContain(FAKE_PROVIDER_KEY);
      expect(JSON.stringify(consent)).not.toContain(FAKE_PROVIDER_KEY);
      expect(logs.join('\n')).not.toContain(FAKE_PROVIDER_KEY);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
