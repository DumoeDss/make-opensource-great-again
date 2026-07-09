/**
 * apiClient.test.ts — the custom-provider + provider-key client methods (task
 * 7.3). Mocks `global.fetch`; asserts the right method/URL/body and that no key
 * value is ever returned to the caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient } from '../api/client';
import type { CustomProviderInput } from '../api/types';

function mockFetch(status: number, body: unknown): void {
  global.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function lastCall(): [string, RequestInit] {
  const mock = global.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
}

afterEach(() => {
  vi.restoreAllMocks();
});

const INPUT: CustomProviderInput = {
  id: 'my-llm',
  name: 'My LLM',
  apiFormat: 'gemini',
  apiBaseUrl: 'https://api.example.com',
  models: ['m-1'],
};

describe('apiClient custom-provider methods', () => {
  it('createCustomProvider POSTs the input and returns the provider', async () => {
    mockFetch(201, { provider: { ...INPUT } });
    const created = await apiClient.createCustomProvider(INPUT);
    expect(created.id).toBe('my-llm');
    const [url, init] = lastCall();
    expect(url).toBe('/api/custom-providers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(INPUT);
  });

  it('listCustomProviders GETs the custom-providers route', async () => {
    mockFetch(200, { providers: [{ ...INPUT }] });
    const list = await apiClient.listCustomProviders();
    expect(list).toHaveLength(1);
    expect(lastCall()[0]).toBe('/api/custom-providers');
  });

  it('updateCustomProvider PUTs to the id route without the id in the body', async () => {
    mockFetch(200, { provider: { ...INPUT, name: 'Renamed' } });
    const { id: _id, ...fields } = INPUT;
    const updated = await apiClient.updateCustomProvider('my-llm', fields);
    expect(updated.name).toBe('Renamed');
    const [url, init] = lastCall();
    expect(url).toBe('/api/custom-providers/my-llm');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).not.toHaveProperty('id');
  });

  it('deleteCustomProvider DELETEs the id route', async () => {
    mockFetch(200, { deleted: true });
    await apiClient.deleteCustomProvider('my-llm');
    const [url, init] = lastCall();
    expect(url).toBe('/api/custom-providers/my-llm');
    expect(init.method).toBe('DELETE');
  });

  it('rejects when the daemon returns an error status', async () => {
    mockFetch(409, { error: 'exists', code: 'PROVIDER_EXISTS' });
    await expect(apiClient.createCustomProvider(INPUT)).rejects.toThrow(/exists/);
  });
});

describe('apiClient provider-key methods', () => {
  it('getKeyStatus returns the configured-boolean map only', async () => {
    mockFetch(200, { status: { deepseek: { configured: true } } });
    const status = await apiClient.getKeyStatus();
    expect(status.deepseek).toEqual({ configured: true });
    // The whole payload carries no key bytes — only booleans.
    expect(JSON.stringify(status)).not.toMatch(/sk-/);
  });

  it('setProviderKey PUTs the key and returns void (no key echoed back)', async () => {
    mockFetch(200, { configured: true });
    const result = await apiClient.setProviderKey('deepseek', 'sk-FAKE-123');
    expect(result).toBeUndefined();
    const [url, init] = lastCall();
    expect(url).toBe('/api/provider-keys/deepseek');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'sk-FAKE-123' });
  });

  it('clearProviderKey DELETEs the key route', async () => {
    mockFetch(200, { configured: false });
    await apiClient.clearProviderKey('deepseek');
    const [url, init] = lastCall();
    expect(url).toBe('/api/provider-keys/deepseek');
    expect(init.method).toBe('DELETE');
  });
});
