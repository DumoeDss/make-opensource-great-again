// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { QueueItem, SanitizationReport, SessionRef } from '../api/types';
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
    getPreflight: vi.fn(async () => ({
      dataRepoConfigured: false,
      gitAvailable: true,
      ghAvailable: false,
      ghAuthenticated: false,
      repoClean: true,
    })),
    publishPlan: vi.fn(),
    publishStage: vi.fn(),
    publishSubmit: vi.fn(),
    ...over,
  } as ApiClient;
}

function makeRef(over: Partial<SessionRef> = {}): SessionRef {
  return {
    sourceId: 'src',
    projectKey: 'proj',
    id: 'sess',
    path: '/p/sess.jsonl',
    title: 'Session',
    cwd: null,
    updatedAt: 0,
    sizeBytes: 0,
    ...over,
  };
}

/** A single-review queue with a fixed reviewId of `r1` (matches the legacy assertions). */
function one(report: SanitizationReport): QueueItem[] {
  return [{ review: { reviewId: 'r1', report, rulesetWarnings: [] }, ref: makeRef() }];
}

/** An N-item queue; reviewIds are r1..rN, refs get index-based titles. */
function many(...reports: SanitizationReport[]): QueueItem[] {
  return reports.map((report, i) => ({
    review: { reviewId: `r${i + 1}`, report, rulesetWarnings: [] },
    ref: makeRef({ id: `sess${i + 1}`, title: `Session ${i + 1}` }),
  }));
}

describe('ReviewView journey (single session — legacy contracts on a 1-item queue)', () => {
  it('dispositioning a finding calls the client and updates the lock badge', async () => {
    const initial = makeReport([makeFinding({ id: 'fx', disposition: 'pending' })]);
    const next = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const setDisposition = vi.fn(async () => ({ report: next, gate: next.gate }));
    const client = fakeClient({ setDisposition });

    const { getByTestId } = render(<ReviewView client={client} items={one(initial)} />);

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

    const { getByTestId } = render(<ReviewView client={client} items={one(initial)} />);
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

    const { getByTestId } = render(<ReviewView client={client} items={one(initial)} />);
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

    const { getByTestId } = render(<ReviewView client={client} items={one(cleared)} />);

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

    const { getByTestId } = render(<ReviewView client={client} items={one(cleared)} />);
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

  it('N=1 has no queue bar and renders ExitCards at step ④', () => {
    const cleared = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const { getByTestId, queryByTestId } = render(
      <ReviewView client={fakeClient()} items={one(cleared)} />,
    );
    expect(queryByTestId('queue-bar')).toBeNull();

    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('sign-checkbox'));
    fireEvent.click(getByTestId('sign-submit'));

    expect(getByTestId('exit-cards')).toBeTruthy();
    expect(queryByTestId('batch-exit-summary')).toBeNull();
  });
});

describe('ReviewView queue journey (N>1)', () => {
  const clearedFinding = () => makeFinding({ id: 'fx', disposition: 'replace' });

  function signCurrent(getByTestId: (id: string) => HTMLElement): void {
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('sign-checkbox'));
    fireEvent.click(getByTestId('sign-submit'));
  }

  it('renders a queue bar and advances to the next unsigned item on sign', () => {
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);

    // Two-item queue → the bar shows 会话 1/2 and a chip per item.
    expect(getByTestId('queue-bar').textContent).toContain('会话 1/2');
    expect(getByTestId('queue-item-1')).toBeTruthy();
    expect(getByTestId('queue-item-2')).toBeTruthy();

    // ④ is gated until EVERY item is signed.
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true);

    // Sign item 1 → auto-advance to item 2, and item 1's chip flips to 已签署.
    signCurrent(getByTestId);
    expect(getByTestId('queue-bar').textContent).toContain('会话 2/2');
    expect(getByTestId('queue-item-1').getAttribute('data-state')).toBe('已签署');
    // Still not all signed → ④ still gated.
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the batch exit summary only once every item is signed', () => {
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);

    signCurrent(getByTestId); // item 1 → advances to item 2
    signCurrent(getByTestId); // item 2 → all signed

    expect(getByTestId('lock-badge').textContent).toContain('已签署');
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(false);
    // ④ auto-entered → the N>1 transitional summary with placeholder cards.
    expect(getByTestId('batch-exit-summary')).toBeTruthy();
    expect(getByTestId('exit-placeholder-one')).toBeTruthy();
    expect(getByTestId('exit-placeholder-two')).toBeTruthy();
  });

  it('editing one signed item voids only that item, re-locking the exit', async () => {
    const afterEdit = makeReport([makeFinding({ id: 'fx', disposition: 'delete' })]);
    const setDisposition = vi.fn(async () => ({ report: afterEdit, gate: afterEdit.gate }));
    const client = fakeClient({ setDisposition });
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));

    const { getByTestId } = render(<ReviewView client={client} items={items} />);
    signCurrent(getByTestId); // item 1 signed → on item 2
    signCurrent(getByTestId); // item 2 signed → all signed, at ④

    // Jump back to item 1 and edit its disposition → void-confirm intercepts.
    fireEvent.click(getByTestId('queue-item-1'));
    fireEvent.click(getByTestId('goto-step-2'));
    fireEvent.click(getByTestId('disp-fx-delete'));
    fireEvent.click(screen.getByTestId('dialog-confirm-ok-btn'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'delete');

    // Only item 1's signature is voided → ④ re-locked; item 2 stays signed.
    await waitFor(() => expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(true));
    expect(getByTestId('queue-item-2').getAttribute('data-state')).toBe('已签署');
  });

  it('leaving the queue with progress prompts a restart confirm', () => {
    const onRestart = vi.fn();
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId } = render(
      <ReviewView client={fakeClient()} items={items} onRestart={onRestart} />,
    );

    signCurrent(getByTestId); // makes the queue "touched"/signed
    fireEvent.click(getByTestId('restart'));
    expect(screen.getByTestId('restart-confirm')).toBeTruthy();
    expect(onRestart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('restart-confirm-ok-btn'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
