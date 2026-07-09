// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { ProviderTarget, ReplayMode, SubmitEstimate } from '../api/types';
import { BatchSubmitPanel, type BatchSubmitItem } from '../components/journey/BatchSubmitPanel';

afterEach(cleanup);

const PROVIDERS: ProviderTarget[] = [
  { id: 'p1', name: 'Provider One', apiFormat: 'openai', apiBaseUrl: 'https://x', models: ['m1', 'm2'] },
];

const ITEMS: BatchSubmitItem[] = [
  { reviewId: 'r1', sessionId: 's1', title: 'Session 1' },
  { reviewId: 'r2', sessionId: 's2', title: 'Session 2' },
];

/** Estimate whose contentHash is derived from the reviewId, to prove per-item binding. */
function estimateFor(reviewId: string): SubmitEstimate {
  return {
    replayMode: 'single-shot' as ReplayMode,
    inputTokens: 60,
    outputTokens: 40,
    totalTokens: 100,
    requestCount: 1,
    estimatedCostUsd: 0.01,
    contentHash: `hash-${reviewId}`,
  };
}

function receiptFor(reviewId: string): Record<string, unknown> {
  return {
    submissionId: `sub-${reviewId}`,
    targetProviderId: 'p1',
    targetModel: 'm1',
    replayMode: 'single-shot',
    submittedAt: '2026-07-10T00:00:00.000Z',
  };
}

function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listProviders: vi.fn(async () => PROVIDERS),
    estimateSubmit: vi.fn(async (reviewId: string) => estimateFor(reviewId)),
    submit: vi.fn(async (reviewId: string) => ({ ok: true as const, receipt: receiptFor(reviewId) })),
    ...over,
  } as unknown as ApiClient;
}

/** Estimate every item, then check both acknowledgment boxes. */
async function estimateAndAck(getByTestId: (id: string) => HTMLElement): Promise<void> {
  fireEvent.click(getByTestId('batch-estimate-all'));
  await waitFor(() => expect(getByTestId('batch-estimate')).toBeTruthy());
  fireEvent.click(getByTestId('batch-ack-tos'));
  fireEvent.click(getByTestId('batch-ack-retention'));
}

describe('BatchSubmitPanel', () => {
  it('estimates every item and shows the aggregate total + count', async () => {
    const { getByTestId, findByTestId } = render(
      <BatchSubmitPanel client={fakeClient()} items={ITEMS} onSubmittedAll={vi.fn()} />,
    );
    await findByTestId('batch-submit-provider');
    fireEvent.click(getByTestId('batch-estimate-all'));
    const box = await findByTestId('batch-estimate');
    expect(box.textContent).toContain('200'); // 2 × 100 tokens
    expect(box.textContent).toContain('共 2 条');
  });

  it('invalidates the aggregate estimate when the target changes', async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(
      <BatchSubmitPanel client={fakeClient()} items={ITEMS} onSubmittedAll={vi.fn()} />,
    );
    await findByTestId('batch-submit-provider');
    fireEvent.click(getByTestId('batch-estimate-all'));
    await findByTestId('batch-estimate');
    // Switch model → estimates invalidate → the aggregate box disappears.
    fireEvent.change(getByTestId('batch-submit-model'), { target: { value: 'm2' } });
    expect(queryByTestId('batch-estimate')).toBeNull();
  });

  it('submits sequentially with each consent bound to that item’s contentHash', async () => {
    const submit = vi.fn(async (reviewId: string, _body: { consent: { contentHash: string } }) => ({
      ok: true as const,
      receipt: receiptFor(reviewId),
    }));
    const onSubmittedAll = vi.fn();
    const { getByTestId, findByTestId } = render(
      <BatchSubmitPanel
        client={fakeClient({ submit: submit as unknown as ApiClient['submit'] })}
        items={ITEMS}
        onSubmittedAll={onSubmittedAll}
      />,
    );
    await findByTestId('batch-submit-provider');
    await estimateAndAck(getByTestId);

    fireEvent.click(getByTestId('batch-submit-run'));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));

    // Each submission's consent carries THAT review's content hash.
    const [id0, body0] = submit.mock.calls[0];
    const [id1, body1] = submit.mock.calls[1];
    expect(id0).toBe('r1');
    expect(body0.consent.contentHash).toBe('hash-r1');
    expect(id1).toBe('r2');
    expect(body1.consent.contentHash).toBe('hash-r2');
    await waitFor(() => expect(onSubmittedAll).toHaveBeenCalledTimes(1));
  });

  it('keeps going after a mid-item failure, shows retry, and only completes after retry succeeds', async () => {
    let failR2 = true;
    const submit = vi.fn(async (reviewId: string, _body: { consent: { contentHash: string } }) =>
      reviewId === 'r2' && failR2
        ? { ok: false as const, status: 500, error: 'boom' }
        : { ok: true as const, receipt: receiptFor(reviewId) },
    );
    const onSubmittedAll = vi.fn();
    const { getByTestId, findByTestId } = render(
      <BatchSubmitPanel
        client={fakeClient({ submit: submit as unknown as ApiClient['submit'] })}
        items={ITEMS}
        onSubmittedAll={onSubmittedAll}
      />,
    );
    await findByTestId('batch-submit-provider');
    await estimateAndAck(getByTestId);

    fireEvent.click(getByTestId('batch-submit-run'));
    // Both items were attempted despite r2 failing (loop does not stop).
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    const s1Row = await findByTestId('batch-submit-result-s1');
    expect(s1Row.textContent).toContain('已直投');
    expect(getByTestId('batch-submit-retry-s2')).toBeTruthy();
    expect(onSubmittedAll).not.toHaveBeenCalled();

    // Retry r2 successfully → every item now has a receipt → completion fires.
    failR2 = false;
    fireEvent.click(getByTestId('batch-submit-retry-s2'));
    await waitFor(() => expect(onSubmittedAll).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(getByTestId('batch-submit-result-s2')).getByText(/已直投/)).toBeTruthy(),
    );
  });
});
