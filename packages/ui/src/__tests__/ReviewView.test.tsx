// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { ReviewView } from '../components/ReviewView';
import { makeFinding, makeNonText, makeReport } from './_fixtures';

afterEach(cleanup);

/** A fully-typed ApiClient stub; override only the methods a test exercises. */
function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listSources: vi.fn(),
    listProjects: vi.fn(),
    listSessions: vi.fn(),
    createReview: vi.fn(),
    setDisposition: vi.fn(),
    batch: vi.fn(),
    setNonText: vi.fn(),
    getGate: vi.fn(),
    exportReview: vi.fn(),
    listProviders: vi.fn(),
    estimateSubmit: vi.fn(),
    submit: vi.fn(),
    ...over,
  } as ApiClient;
}

describe('ReviewView', () => {
  it('dispositioning a finding calls the client and updates gate counts', async () => {
    const initial = makeReport([makeFinding({ id: 'fx', disposition: 'pending' })]);
    const next = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const setDisposition = vi.fn(async () => ({ report: next, gate: next.gate }));
    const client = fakeClient({ setDisposition });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={initial} warnings={[]} />,
    );

    // Locked to start: 1 blocking pending, export disabled.
    expect(getByTestId('blocking-pending').textContent).toBe('1');
    expect((getByTestId('export-button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByTestId('disp-fx-replace'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'replace');

    await waitFor(() => expect(getByTestId('blocking-pending').textContent).toBe('0'));
    expect(getByTestId('gate-status').textContent).toContain('unlocked');
  });

  it('batch-by-rule delegates to the client', async () => {
    const initial = makeReport([makeFinding({ id: 'a' }), makeFinding({ id: 'b' })]);
    const batch = vi.fn(async () => ({ report: initial, gate: initial.gate }));
    const client = fakeClient({ batch });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={initial} warnings={[]} />,
    );
    fireEvent.click(getByTestId('batch-rule-aws-access-token'));
    await waitFor(() =>
      expect(batch).toHaveBeenCalledWith('r1', 'rule', 'aws-access-token', 'replace'),
    );
  });

  it('confirming a non-text item decrements nonTextPending', async () => {
    const initial = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'pending' })]);
    const next = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'keep' })]);
    const setNonText = vi.fn(async () => ({ report: next, gate: next.gate }));
    const client = fakeClient({ setNonText });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={initial} warnings={[]} />,
    );
    expect(getByTestId('nontext-pending').textContent).toBe('1');

    fireEvent.click(getByTestId('tab-nontext'));
    fireEvent.click(getByTestId('nontext-keep-m1'));
    expect(setNonText).toHaveBeenCalledWith('r1', 'm1', 'keep');

    await waitFor(() => expect(getByTestId('nontext-pending').textContent).toBe('0'));
  });
});
