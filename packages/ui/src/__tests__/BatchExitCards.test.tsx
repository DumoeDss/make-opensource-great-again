// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { BatchExitCards, type BatchExitItem } from '../components/journey/BatchExitCards';
import {
  blockedStatus,
  directStatus,
  existingForkStatus,
  forkConfirmationStatus,
  loginRequiredStatus,
  publicationPreview,
  unconfiguredStatus,
} from './publicationFixtures';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    inspectPublication: vi.fn(async () => ({ ok: true as const, data: directStatus() })),
    previewPublication: vi.fn(async () => ({
      ok: true as const,
      data: publicationPreview({
        contribution: { ...publicationPreview().contribution, recordCount: ITEMS.length },
      }),
    })),
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

describe('BatchExitCards 出口① publication status', () => {
  it.each([
    ['login required', loginRequiredStatus(), ['community/dataset', 'main']],
    [
      'fork confirmation',
      forkConfirmationStatus(),
      ['contributor', 'community/dataset', 'contributor/dataset'],
    ],
    [
      'ready direct',
      directStatus(),
      ['contributor', 'community/dataset', 'main', 'a'.repeat(40), 'direct', '7'],
    ],
    [
      'ready existing fork',
      existingForkStatus(),
      [
        'contributor',
        'community/dataset',
        'main',
        'a'.repeat(40),
        'fork',
        'contributor/dataset',
        '7',
      ],
    ],
  ])('shows every required safe compact fact for %s', async (_name, status, facts) => {
    const client = fakeClient({
      inspectPublication: vi.fn(async () => ({ ok: true as const, data: status })),
    });
    const { getByTestId } = renderCards(client);
    await waitFor(() =>
      expect(getByTestId('batch-exit-one-state').textContent).toContain(facts[0]),
    );
    const text = getByTestId('batch-exit-one-state').textContent ?? '';
    for (const fact of facts) expect(text).toContain(fact);
  });

  it('disables 出口① when no GitHub target is configured', async () => {
    const client = fakeClient({
      inspectPublication: vi.fn(async () => ({
        ok: true as const,
        data: unconfiguredStatus(),
      })),
    });
    const { getByTestId } = renderCards(client);
    await waitFor(() =>
      expect(getByTestId('batch-exit-one-state').textContent).toContain('Unconfigured'),
    );
    expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables direct ready and fork-confirmation status', async () => {
    const { getByTestId } = renderCards(fakeClient());
    await waitFor(() =>
      expect(getByTestId('batch-exit-one-state').textContent).toContain('Ready · direct'),
    );
    expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    const forkClient = fakeClient({
      inspectPublication: vi.fn(async () => ({
        ok: true as const,
        data: forkConfirmationStatus(),
      })),
    });
    const fork = renderCards(forkClient);
    await waitFor(() =>
      expect(fork.getByTestId('batch-exit-one-state').textContent).toContain(
        'Fork confirmation required',
      ),
    );
    expect((fork.getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses the shared wizard and sends every queue review ID once', async () => {
    const client = fakeClient();
    const { getByTestId, findByTestId } = renderCards(client);
    await waitFor(() =>
      expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('batch-exit-one-cta'));
    await findByTestId('publication-preview');
    expect(client.previewPublication).toHaveBeenCalledWith(['r1', 'r2']);
    expect(client.previewPublication).toHaveBeenCalledTimes(1);
  });

  it('keeps direct submit and export available while GitHub publication is blocked', async () => {
    const client = fakeClient({
      inspectPublication: vi.fn(async () => ({
        ok: true as const,
        data: blockedStatus(false),
      })),
    });
    const { getByTestId } = renderCards(client);
    await waitFor(() =>
      expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(getByTestId('batch-exit-two')).toBeTruthy();
    expect((getByTestId('batch-export-all') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('BatchExitCards export', () => {
  beforeEach(() => {
    // jsdom lacks object-URL support; stub it so the blob download path runs.
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
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
