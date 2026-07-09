// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { ReviewView } from '../components/ReviewView';
import { makeFinding, makeNonText, makeReport } from './_fixtures';

afterEach(cleanup);

/** A fully-typed ApiClient stub; override only the methods a test exercises. */
function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getHealth: vi.fn(async () => ({ name: 'mosga-daemon', version: '0.1.0' })),
    listSources: vi.fn(async () => []),
    listProjects: vi.fn(),
    listSessions: vi.fn(async () => []),
    createReview: vi.fn(),
    setDisposition: vi.fn(),
    batch: vi.fn(),
    setNonText: vi.fn(),
    getGate: vi.fn(),
    exportReview: vi.fn(),
    listProviders: vi.fn(async () => []),
    estimateSubmit: vi.fn(),
    submit: vi.fn(),
    ...over,
  } as ApiClient;
}

describe('ReviewView journey', () => {
  it('dispositioning a finding calls the client and updates the lock badge', async () => {
    const initial = makeReport([makeFinding({ id: 'fx', disposition: 'pending' })]);
    const next = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const setDisposition = vi.fn(async () => ({ report: next, gate: next.gate }));
    const client = fakeClient({ setDisposition });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={initial} warnings={[]} />,
    );

    // Locked to start: 1 remaining, exit step (④) not enterable.
    expect(getByTestId('lock-badge').textContent).toContain('还差 1');
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByTestId('disp-fx-replace'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'replace');

    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已解锁'));
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

  it('confirming a non-text item decrements the remaining count', async () => {
    const initial = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'pending' })]);
    const next = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'keep' })]);
    const setNonText = vi.fn(async () => ({ report: next, gate: next.gate }));
    const client = fakeClient({ setNonText });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={initial} warnings={[]} />,
    );
    expect(getByTestId('lock-badge').textContent).toContain('还差 1');

    // The 图像/附件 group holds the non-text queue.
    fireEvent.click(getByTestId('group-nontext'));
    fireEvent.click(getByTestId('nontext-keep-m1'));
    expect(setNonText).toHaveBeenCalledWith('r1', 'm1', 'keep');

    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已解锁'));
  });

  it('signing gates the exit; editing after signing voids it via the confirm dialog', async () => {
    const cleared = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const afterEdit = makeReport([makeFinding({ id: 'fx', disposition: 'delete' })]);
    const setDisposition = vi.fn(async () => ({ report: afterEdit, gate: afterEdit.gate }));
    const client = fakeClient({ setDisposition });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={cleared} warnings={[]} />,
    );

    // Cleared but unsigned → ④ still gated.
    expect(getByTestId('lock-badge').textContent).toContain('已解锁');
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true);

    // Enter ③ and sign.
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('sign-checkbox'));
    fireEvent.click(getByTestId('sign-submit'));

    // Signed → badge 已签署, ④ now enterable.
    expect(getByTestId('lock-badge').textContent).toContain('已签署');
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(false);

    // Back to ② and change a disposition → the void-confirm dialog intercepts.
    fireEvent.click(getByTestId('goto-step-2'));
    fireEvent.click(getByTestId('disp-fx-delete'));
    expect(screen.getByTestId('dialog-confirm')).toBeTruthy();
    // Guard intercepted — no daemon call until the user confirms.
    expect(setDisposition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dialog-confirm-ok-btn'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'delete');

    // Signature voided → ④ re-locked (unsigned), badge back to 已解锁.
    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已解锁'));
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancelling the void dialog makes no daemon call', async () => {
    const cleared = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const setDisposition = vi.fn(async () => ({ report: cleared, gate: cleared.gate }));
    const client = fakeClient({ setDisposition });

    const { getByTestId } = render(
      <ReviewView client={client} reviewId="r1" initialReport={cleared} warnings={[]} />,
    );
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('sign-checkbox'));
    fireEvent.click(getByTestId('sign-submit'));
    fireEvent.click(getByTestId('goto-step-2'));
    fireEvent.click(getByTestId('disp-fx-delete'));

    fireEvent.click(screen.getByTestId('dialog-confirm-cancel-btn'));
    expect(setDisposition).not.toHaveBeenCalled();
    // Still signed — cancel is a no-op.
    expect(getByTestId('lock-badge').textContent).toContain('已签署');
  });
});
