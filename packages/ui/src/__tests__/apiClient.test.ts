/**
 * apiClient.test.ts — the custom-provider + provider-key client methods (task
 * 7.3). Mocks `global.fetch`; asserts the right method/URL/body and that no key
 * value is ever returned to the caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiClient } from '../api/client';
import type { CustomProviderInput, PublicationErrorBody } from '../api/types';
import {
  directStatus,
  publicationError,
  publicationPreview,
  publicationReceipt,
  unconfiguredStatus,
} from './publicationFixtures';

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

describe('apiClient publication contract', () => {
  it('inspects publication status over the one relative GET route', async () => {
    mockFetch(200, directStatus());
    await expect(apiClient.inspectPublication()).resolves.toEqual({
      ok: true,
      data: directStatus(),
    });
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith('/api/publish', undefined);
  });

  it('configures only the repository slug with JSON', async () => {
    mockFetch(200, directStatus());
    await apiClient.configurePublicationTarget('community/dataset');
    const [url, init] = lastCall();
    expect(url).toBe('/api/publish/target');
    expect(init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ repository: 'community/dataset' });
  });

  it('clears with JSON content type and no request body', async () => {
    mockFetch(200, unconfiguredStatus(8));
    await apiClient.clearPublicationTarget();
    const [url, init] = lastCall();
    expect(url).toBe('/api/publish/target');
    expect(init).toMatchObject({
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(init.body).toBeUndefined();
  });

  it('previews only the selected review IDs', async () => {
    mockFetch(201, publicationPreview());
    await apiClient.previewPublication(['review-a', 'review-b']);
    const [url, init] = lastCall();
    expect(url).toBe('/api/publish/preview');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual({ reviewIds: ['review-a', 'review-b'] });
  });

  it('submits only the exact sealed binding and literal confirmation', async () => {
    mockFetch(200, publicationReceipt());
    const input = {
      publicationRef: 'publication_fixture',
      targetRevision: 7,
      contentDigest: 'a'.repeat(64),
      confirmPublic: true as const,
    };
    await expect(apiClient.submitPublication(input)).resolves.toEqual({
      ok: true,
      data: publicationReceipt(),
    });
    const [url, init] = lastCall();
    expect(url).toBe('/api/publish/submit');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it.each([
    [
      'inspect',
      () => apiClient.inspectPublication(),
      directStatus(),
      {
        ...directStatus(),
        workspace: 'C:\\private\\status',
        target: {
          ...directStatus().target,
          token: 'status-token',
          manifest: {
            ...directStatus().target.manifest,
            stdout: 'raw status output',
          },
        },
      },
    ],
    [
      'configure',
      () => apiClient.configurePublicationTarget('community/dataset'),
      directStatus(),
      { ...directStatus(), command: 'git push status-secret' },
    ],
    [
      'clear',
      () => apiClient.clearPublicationTarget(),
      unconfiguredStatus(8),
      { ...unconfiguredStatus(8), stderr: 'raw clear failure' },
    ],
    [
      'preview',
      () => apiClient.previewPublication(['review-a']),
      publicationPreview(),
      {
        ...publicationPreview(),
        workspace: '/private/preview',
        contribution: {
          ...publicationPreview().contribution,
          contents: 'exact preview contents',
          files: publicationPreview().contribution.files.map((file) => ({
            ...file,
            contents: 'exact file contents',
          })),
        },
      },
    ],
    [
      'submit',
      () =>
        apiClient.submitPublication({
          publicationRef: 'publication_fixture',
          targetRevision: 7,
          contentDigest: 'a'.repeat(64),
          confirmPublic: true,
        }),
      publicationReceipt(),
      {
        ...publicationReceipt(),
        token: 'receipt-token',
        command: 'git push receipt-secret',
      },
    ],
  ] as const)('projects allowlisted fields from successful %s responses', async (
    _name,
    invoke,
    expected,
    payload,
  ) => {
    mockFetch(200, payload);
    const result = await invoke();
    expect(result).toEqual({ ok: true, data: expected });
    expect(JSON.stringify(result)).not.toMatch(
      /C:\\\\private|status-token|raw status output|git push|raw clear failure|\/private\/preview|exact preview contents|exact file contents|receipt-token/,
    );
  });

  it.each([
    [
      'inspect',
      () => apiClient.inspectPublication(),
      { ...directStatus(), revision: -1 },
      'target',
    ],
    [
      'configure',
      () => apiClient.configurePublicationTarget('community/dataset'),
      {
        ...directStatus(),
        target: {
          ...directStatus().target,
          manifest: {
            ...directStatus().target.manifest,
            acceptedSchemaVersions: '0.1.0',
          },
        },
      },
      'target',
    ],
    [
      'clear',
      () => apiClient.clearPublicationTarget(),
      { ...unconfiguredStatus(8), revision: 1.5 },
      'target',
    ],
    [
      'preview',
      () => apiClient.previewPublication(['review-a']),
      {
        ...publicationPreview(),
        contribution: { ...publicationPreview().contribution, files: null },
      },
      'preview',
    ],
    [
      'submit',
      () =>
        apiClient.submitPublication({
          publicationRef: 'publication_fixture',
          targetRevision: 7,
          contentDigest: 'a'.repeat(64),
          confirmPublic: true,
        }),
      { ...publicationReceipt(), contentDigest: 'not-a-hash' },
      'pull_request',
    ],
  ] as const)('maps malformed successful %s responses to safe transport errors', async (
    _name,
    invoke,
    payload,
    phase,
  ) => {
    mockFetch(200, payload);
    await expect(invoke()).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'transport_error',
        phase,
      }),
    });
  });

  it('projects only stable safe error attribution', async () => {
    const safe: PublicationErrorBody = publicationError({
      code: 'GATE_LOCKED',
      phase: 'preview',
      reviewId: 'review-a',
      gate: {
        blockingTotal: 2,
        blockingPending: 1,
        nonTextPending: 1,
        unlocked: false,
      },
      refusals: [
        {
          reviewId: 'review-a',
          sessionId: 'session-a',
          blockingByRule: { secret: 2 },
        },
      ],
    });
    mockFetch(409, {
      ...safe,
      token: 'ghp_FAKE_SECRET',
      workspace: 'C:\\Users\\private\\publication',
      command: 'git push origin secret',
      stderr: 'fatal: sensitive',
      gate: { ...safe.gate, rawMatch: 'exact secret' },
      refusals: safe.refusals?.map((item) => ({ ...item, contents: 'exact record' })),
    });
    const result = await apiClient.previewPublication(['review-a']);
    expect(result).toEqual({ ok: false, error: safe });
    expect(JSON.stringify(result)).not.toMatch(
      /ghp_FAKE_SECRET|C:\\\\Users|git push|stderr|rawMatch|exact record/,
    );
  });

  it.each([
    ['inspect', () => apiClient.inspectPublication()],
    ['configure', () => apiClient.configurePublicationTarget('community/dataset')],
    ['clear', () => apiClient.clearPublicationTarget()],
    ['preview', () => apiClient.previewPublication(['review-a'])],
    [
      'submit',
      () =>
        apiClient.submitPublication({
          publicationRef: 'publication_fixture',
          targetRevision: 7,
          contentDigest: 'a'.repeat(64),
          confirmPublic: true,
        }),
    ],
  ])('returns the typed stable error for %s', async (_name, invoke) => {
    const error = publicationError();
    mockFetch(503, error);
    await expect(invoke()).resolves.toEqual({ ok: false, error });
  });

  it('maps malformed and network failures to generic local copy', async () => {
    mockFetch(500, {
      error: 'ghp_FAKE_SECRET C:\\Users\\private git push',
      stderr: 'raw failure',
    });
    const malformed = await apiClient.inspectPublication();
    expect(malformed).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'transport_error', phase: 'target' }),
    });
    expect(JSON.stringify(malformed)).not.toMatch(/ghp_FAKE_SECRET|C:\\\\Users|git push|raw failure/);

    global.fetch = vi.fn(async () => {
      throw new Error('token ghp_FAKE_SECRET at C:\\Users\\private');
    }) as unknown as typeof fetch;
    const network = await apiClient.previewPublication(['review-a']);
    expect(network).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'transport_error', phase: 'preview' }),
    });
    expect(JSON.stringify(network)).not.toContain('ghp_FAKE_SECRET');
  });
});
