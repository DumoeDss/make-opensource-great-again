// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { PublishPreflight } from '../api/types';
import { BatchExitCards, type BatchExitItem } from '../components/journey/BatchExitCards';

afterEach(cleanup);

const READY: PublishPreflight = {
  dataRepoConfigured: true,
  gitAvailable: true,
  ghAvailable: true,
  ghAuthenticated: true,
  repoClean: true,
};

const ITEMS: BatchExitItem[] = [
  { reviewId: 'r1', sessionId: 's1', title: 'Session 1' },
  { reviewId: 'r2', sessionId: 's2', title: 'Session 2' },
];

const okExport = (sessionId: string) =>
  ({
    ok: true as const,
    data: {
      session: { schemaVersion: '0.1.0', meta: {}, session: { sessionId }, messages: [] },
      gate: { blockingTotal: 0, blockingPending: 0, nonTextPending: 0, unlocked: true },
    },
  }) as unknown as { ok: true; data: { session: unknown; gate: unknown } };

function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getPreflight: vi.fn(async () => READY),
    listProviders: vi.fn(async () => []),
    exportReview: vi.fn(async (reviewId: string) => okExport(reviewId)),
    ...over,
  } as unknown as ApiClient;
}

function renderCards(client: ApiClient): ReturnType<typeof render> {
  return render(
    <BatchExitCards
      client={client}
      items={ITEMS}
      onPublished={vi.fn()}
      onSubmittedAll={vi.fn()}
      onJumpToSession={vi.fn()}
    />,
  );
}

describe('BatchExitCards 出口① preflight card', () => {
  it('disables 出口① with 需配置 when no data repo is configured', async () => {
    const client = fakeClient({ getPreflight: vi.fn(async () => ({ ...READY, dataRepoConfigured: false })) });
    const { getByTestId } = renderCards(client);
    await waitFor(() => expect(getByTestId('batch-exit-one-state').textContent).toContain('需配置'));
    expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables 出口① when everything is 就绪', async () => {
    const { getByTestId } = renderCards(fakeClient());
    await waitFor(() => expect(getByTestId('batch-exit-one-state').textContent).toContain('就绪'));
    expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('BatchExitCards export', () => {
  beforeEach(() => {
    // jsdom lacks object-URL support; stub it so the blob download path runs.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
  });

  it('exports each session and surfaces a refused export inline (slice-1 M3)', async () => {
    // r1 exports fine; r2 is refused (409) → inline per-item error, no file.
    const exportReview = vi.fn(async (reviewId: string) =>
      reviewId === 'r2'
        ? { ok: false as const, gate: { blockingTotal: 1, blockingPending: 1, nonTextPending: 0, unlocked: false } }
        : okExport(reviewId),
    );
    const client = fakeClient({ exportReview: exportReview as unknown as ApiClient['exportReview'] });
    const { getByTestId } = renderCards(client);

    fireEvent.click(getByTestId('batch-export-all'));
    await waitFor(() => expect(exportReview).toHaveBeenCalledTimes(2));

    // The good record produced a blob download.
    expect((URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL).toHaveBeenCalled();
    // The refused record shows an inline error under its row.
    await waitFor(() =>
      expect(getByTestId('batch-download-s2').closest('li')?.textContent).toContain('导出被拒绝'),
    );
  });

  it('a single per-item download refusal renders inline without downloading', async () => {
    const exportReview = vi.fn(async () => ({
      ok: false as const,
      gate: { blockingTotal: 1, blockingPending: 1, nonTextPending: 0, unlocked: false },
    }));
    const client = fakeClient({ exportReview: exportReview as unknown as ApiClient['exportReview'] });
    const { getByTestId } = renderCards(client);

    fireEvent.click(getByTestId('batch-download-s1'));
    await waitFor(() =>
      expect(getByTestId('batch-download-s1').closest('li')?.textContent).toContain('导出被拒绝'),
    );
    expect((URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL).not.toHaveBeenCalled();
  });
});
