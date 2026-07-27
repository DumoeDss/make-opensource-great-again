// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { PublicationResult, PublicationStatus } from '../api/types';
import {
  blockedStatus,
  directStatus,
  forkConfirmationStatus,
  loginRequiredStatus,
  publicationError,
  publicationTarget,
  unconfiguredStatus,
} from './publicationFixtures';
import {
  canPreviewPublication,
  PublicationStatusView,
} from '../components/publication/PublicationStatusView';
import { usePublication } from '../lib/usePublication';

function publicationClient(
  status: PublicationStatus = directStatus(),
  over: Partial<ApiClient> = {},
): ApiClient {
  const result: PublicationResult<PublicationStatus> = { ok: true, data: status };
  return {
    inspectPublication: vi.fn(async () => result),
    configurePublicationTarget: vi.fn(async () => result),
    clearPublicationTarget: vi.fn(async () => result),
    ...over,
  } as unknown as ApiClient;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('usePublication', () => {
  it('keeps transport loading separate and replaces status on refresh', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: directStatus() })
      .mockResolvedValueOnce({ ok: true, data: blockedStatus(false) });
    const client = publicationClient(directStatus(), { inspectPublication: inspect });
    const { result } = renderHook(() => usePublication(client));
    expect(result.current.loadState).toBe('loading');
    await waitFor(() => expect(result.current.status?.state).toBe('ready'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toEqual(blockedStatus(false));
    expect(result.current.loadState).toBe('loaded');
  });

  it('uses returned configure and clear statuses without deriving readiness', async () => {
    const configurePublicationTarget = vi.fn(async () => ({
      ok: true as const,
      data: forkConfirmationStatus(),
    }));
    const clearPublicationTarget = vi.fn(async () => ({
      ok: true as const,
      data: unconfiguredStatus(8),
    }));
    const client = publicationClient(unconfiguredStatus(), {
      configurePublicationTarget,
      clearPublicationTarget,
    });
    const { result } = renderHook(() => usePublication(client));
    await waitFor(() => expect(result.current.loadState).toBe('loaded'));
    await act(async () => {
      await result.current.configure('community/dataset');
    });
    expect(configurePublicationTarget).toHaveBeenCalledWith('community/dataset');
    expect(result.current.status).toEqual(forkConfirmationStatus());
    await act(async () => {
      await result.current.clear();
    });
    expect(result.current.status).toEqual(unconfiguredStatus(8));
  });

  it('surfaces safe mutation and transport failures', async () => {
    const failure = publicationError({ code: 'invalid_target', phase: 'target' });
    const client = publicationClient(directStatus(), {
      configurePublicationTarget: vi.fn(async () => ({ ok: false as const, error: failure })),
    });
    const { result } = renderHook(() => usePublication(client));
    await waitFor(() => expect(result.current.status).toEqual(directStatus()));
    await act(async () => {
      await result.current.configure('bad');
    });
    expect(result.current.error).toEqual(failure);
    expect(result.current.status).toEqual(directStatus());

    const transport = publicationError({
      code: 'transport_error',
      phase: 'target',
      message: 'The publication service could not be reached.',
    });
    const unavailable = publicationClient(directStatus(), {
      inspectPublication: vi.fn(async () => ({ ok: false as const, error: transport })),
    });
    const unavailableHook = renderHook(() => usePublication(unavailable));
    await waitFor(() => expect(unavailableHook.result.current.loadState).toBe('error'));
    expect(unavailableHook.result.current.status).toBeNull();
  });

  it('does not let an older inspect overwrite a newer configure result', async () => {
    const inspect = deferred<PublicationResult<PublicationStatus>>();
    const configured = { ...directStatus(), revision: 8 };
    const client = publicationClient(directStatus(), {
      inspectPublication: vi.fn(() => inspect.promise),
      configurePublicationTarget: vi.fn(async () => ({
        ok: true as const,
        data: configured,
      })),
    });
    const { result } = renderHook(() => usePublication(client));
    await act(async () => {
      await result.current.configure('community/dataset');
    });
    expect(result.current.status).toEqual(configured);
    await act(async () => {
      inspect.resolve({ ok: true, data: directStatus() });
      await inspect.promise;
    });
    expect(result.current.status).toEqual(configured);
    expect(result.current.loadState).toBe('loaded');
  });

  it('does not let an older inspect overwrite a newer clear result', async () => {
    const inspect = deferred<PublicationResult<PublicationStatus>>();
    const cleared = unconfiguredStatus(8);
    const client = publicationClient(directStatus(), {
      inspectPublication: vi.fn(() => inspect.promise),
      clearPublicationTarget: vi.fn(async () => ({
        ok: true as const,
        data: cleared,
      })),
    });
    const { result } = renderHook(() => usePublication(client));
    await act(async () => {
      await result.current.clear();
    });
    expect(result.current.status).toEqual(cleared);
    await act(async () => {
      inspect.resolve({ ok: true, data: directStatus() });
      await inspect.promise;
    });
    expect(result.current.status).toEqual(cleared);
  });

  it('invalidates requests from a replaced client', async () => {
    const oldInspect = deferred<PublicationResult<PublicationStatus>>();
    const oldClient = publicationClient(directStatus(), {
      inspectPublication: vi.fn(() => oldInspect.promise),
    });
    const replacement = forkConfirmationStatus();
    const newClient = publicationClient(replacement);
    const { result, rerender } = renderHook(
      ({ client }: { client: ApiClient }) => usePublication(client),
      { initialProps: { client: oldClient } },
    );
    rerender({ client: newClient });
    await waitFor(() => expect(result.current.status).toEqual(replacement));
    await act(async () => {
      oldInspect.resolve({ ok: true, data: directStatus() });
      await oldInspect.promise;
    });
    expect(result.current.status).toEqual(replacement);
  });

  it('returns no stale result and performs no state commit after unmount', async () => {
    const inspect = deferred<PublicationResult<PublicationStatus>>();
    const client = publicationClient(directStatus(), {
      inspectPublication: vi.fn(() => inspect.promise),
    });
    const { result, unmount } = renderHook(() => usePublication(client));
    let refresh!: Promise<PublicationStatus | null>;
    act(() => {
      refresh = result.current.refresh();
    });
    unmount();
    inspect.resolve({ ok: true, data: directStatus() });
    await expect(refresh).resolves.toBeNull();
  });
});

describe('PublicationStatusView', () => {
  it.each([
    unconfiguredStatus(),
    loginRequiredStatus(),
    forkConfirmationStatus(),
    directStatus(),
    blockedStatus(false),
  ])('renders the $state state exhaustively', (status) => {
    const { unmount } = render(<PublicationStatusView status={status} detail="full" />);
    expect(screen.getByText(/revision/i)).toBeTruthy();
    unmount();
  });

  it('enables preview only for ready and fork-confirmation status', () => {
    expect(canPreviewPublication(directStatus())).toBe(true);
    expect(canPreviewPublication(forkConfirmationStatus())).toBe(true);
    expect(canPreviewPublication(unconfiguredStatus())).toBe(false);
    expect(canPreviewPublication(loginRequiredStatus())).toBe(false);
    expect(canPreviewPublication(blockedStatus())).toBe(false);
    expect(canPreviewPublication(null)).toBe(false);
  });

  it('does not reuse a target when blocked target is absent', () => {
    render(<PublicationStatusView status={blockedStatus(false)} detail="full" />);
    expect(screen.getByText(/details are unavailable/i)).toBeTruthy();
    expect(screen.queryByText('community/dataset')).toBeNull();
  });

  it('wraps long safe facts and never renders the target URL or unknown leakage', () => {
    const longSlug = `${'owner'.repeat(20)}/${'repo'.repeat(30)}`;
    const status = {
      ...directStatus(),
      target: publicationTarget({
        slug: longSlug,
        url: 'https://example.invalid/raw-remote',
        baseCommitSha: 'f'.repeat(40),
      }),
      workspace: '/private/status-root',
      remoteName: 'status-secret-remote',
      command: 'git push status-secret',
      token: 'status-token-canary',
      stderr: 'status-raw-output',
    } as PublicationStatus & {
      workspace: string;
      remoteName: string;
      command: string;
      token: string;
      stderr: string;
    };
    const { container } = render(<PublicationStatusView status={status} detail="full" />);
    expect(screen.getByText(longSlug).className).toContain('break-all');
    expect(container.textContent).not.toContain('https://example.invalid/raw-remote');
    expect(container.textContent).not.toMatch(
      /\/private\/status-root|status-secret-remote|git push status-secret|status-token-canary|status-raw-output/,
    );
  });
});
