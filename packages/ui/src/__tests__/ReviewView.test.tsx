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
    publishBatchPlan: vi.fn(),
    publishBatchStage: vi.fn(),
    publishBatchSubmit: vi.fn(),
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
    expect(queryByTestId('batch-exit-cards')).toBeNull();
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

  it('opens the batch exit cards only once every item is signed', () => {
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);

    signCurrent(getByTestId); // item 1 → advances to item 2
    signCurrent(getByTestId); // item 2 → all signed

    expect(getByTestId('lock-badge').textContent).toContain('已签署');
    expect((getByTestId('goto-step-4') as HTMLButtonElement).disabled).toBe(false);
    // ④ auto-entered → the N>1 batch exit cards (both real exits).
    expect(getByTestId('batch-exit-cards')).toBeTruthy();
    expect(getByTestId('batch-exit-one')).toBeTruthy();
    expect(getByTestId('batch-exit-two')).toBeTruthy();
  });

  it('a batch wizard per-session refusal jumps to that signed session at ② and edits stay void-guarded', async () => {
    const setDisposition = vi.fn(async () => {
      const r = makeReport([makeFinding({ id: 'fx', disposition: 'delete' })]);
      return { report: r, gate: r.gate };
    });
    const client = fakeClient({
      setDisposition,
      getPreflight: vi.fn(async () => ({
        dataRepoConfigured: true,
        gitAvailable: true,
        ghAvailable: true,
        ghAuthenticated: true,
        repoClean: true,
      })),
      publishBatchPlan: vi.fn(async () => ({
        ok: false as const,
        error: 'refused',
        code: 'precheck_refused',
        blockingBySession: [
          { reviewId: 'r1', sessionId: 'sess-test', blockingByRule: [{ ruleId: 'aws-access-token', count: 1 }] },
        ],
      })),
    });
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId, findByTestId } = render(<ReviewView client={client} items={items} />);

    signCurrent(getByTestId); // item 1 → item 2
    signCurrent(getByTestId); // item 2 → all signed, at ④, current = item 2

    // Open the batch wizard → its pre-check refuses and names session r1.
    await waitFor(() => expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('batch-exit-one-cta'));
    const jump = await findByTestId('jump-to-session-r1-aws-access-token');
    fireEvent.click(jump);

    // Jumped to session 1's step ② (current switched from item 2 to item 1).
    expect(getByTestId('queue-bar').textContent).toContain('会话 1/2');
    expect(getByTestId('disposition-workspace')).toBeTruthy();

    // Session 1 is signed → editing a disposition must go through the void confirm,
    // NOT straight to the daemon (the signature-void guard survives the jump).
    fireEvent.click(getByTestId('disp-fx-delete'));
    expect(screen.getByTestId('dialog-confirm')).toBeTruthy();
    expect(setDisposition).not.toHaveBeenCalled();
  });

  it('a successful batch publish marks the journey 已完成', async () => {
    const client = fakeClient({
      getPreflight: vi.fn(async () => ({
        dataRepoConfigured: true,
        gitAvailable: true,
        ghAvailable: true,
        ghAuthenticated: true,
        repoClean: true,
      })),
      publishBatchPlan: vi.fn(async () => ({
        ok: true as const,
        plan: {
          branch: 'contrib/USER_1/batch-abcd1234',
          targetBranch: 'main',
          prTitle: 'Add 2 sanitized sessions (<USER_1>)',
          prBody: '## Sanitized sessions contribution (batch)',
          commitMessage: 'Add 2 sanitized sessions',
          recordCount: 2,
          ghAvailable: true,
          stagedFiles: ['a.jsonl', 'a.provenance.json', 'b.jsonl', 'b.provenance.json'],
          commands: ['git checkout -b contrib/USER_1/batch-abcd1234'],
          engine: {},
          compareUrl: null,
          totalRecordBytes: 42,
          records: [
            { sessionId: 's1', recordPath: 'a.jsonl', provenancePath: 'a.provenance.json', recordBytes: 21, contentHash: 'a'.repeat(64), messages: 2 },
            { sessionId: 's2', recordPath: 'b.jsonl', provenancePath: 'b.provenance.json', recordBytes: 21, contentHash: 'b'.repeat(64), messages: 3 },
          ],
        },
      })),
      publishBatchSubmit: vi.fn(async () => ({
        ok: true as const,
        result: {
          opened: true as const,
          branch: 'contrib/USER_1/batch-abcd1234',
          receipt: {
            branch: 'contrib/USER_1/batch-abcd1234',
            targetBranch: 'main',
            prTitle: 'Add 2 sanitized sessions (<USER_1>)',
            compareUrl: null,
            submittedAt: '2026-07-10T00:00:00.000Z',
            recordCount: 2,
          },
        },
      })),
    });
    const items = many(makeReport([clearedFinding()]), makeReport([clearedFinding()]));
    const { getByTestId, findByTestId } = render(<ReviewView client={client} items={items} />);

    signCurrent(getByTestId);
    signCurrent(getByTestId);

    await waitFor(() => expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('batch-exit-one-cta'));
    await findByTestId('batch-wizard-step-preview');
    fireEvent.click(getByTestId('batch-wizard-to-submit'));
    fireEvent.click(await findByTestId('batch-wizard-submit-btn'));

    await findByTestId('batch-published-badge');
    expect(client.publishBatchSubmit).toHaveBeenCalledWith(['r1', 'r2']);
    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已完成'));
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

describe('ReviewView UX — triage, one-click clean, and the sign CTA', () => {
  it('one-click clean replaces each pending non-meta rule once and never auto-disposes meta hits', async () => {
    const report = makeReport([
      makeFinding({ id: 'fx', ruleId: 'aws-access-token', disposition: 'pending' }),
      makeFinding({ id: 'fy', ruleId: 'aws-access-token', disposition: 'pending' }),
      // A meta/engine hit — must NOT be auto-disposed.
      makeFinding({ id: 'meta1', ruleId: 'redos-guard', disposition: 'pending' }),
    ]);
    const cleaned = makeReport([
      makeFinding({ id: 'fx', ruleId: 'aws-access-token', disposition: 'replace' }),
      makeFinding({ id: 'fy', ruleId: 'aws-access-token', disposition: 'replace' }),
      makeFinding({ id: 'meta1', ruleId: 'redos-guard', disposition: 'pending' }),
    ]);
    const batch = vi.fn(async (_reviewId: string, _by: string, _key: string, _disp: string) => ({
      report: cleaned,
      gate: cleaned.gate,
    }));
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={one(report)} />);

    // The clean card is offered (2 cleanable hits — the meta hit is excluded).
    expect(getByTestId('clean-all-card').textContent).toContain('2 处');
    fireEvent.click(getByTestId('clean-all'));

    await waitFor(() => expect(batch).toHaveBeenCalledWith('r1', 'rule', 'aws-access-token', 'replace'));
    // Exactly one distinct rule → one batch call; the meta rule is never auto-cleaned.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls.some((c) => c[2] === 'redos-guard')).toBe(false);
  });

  it('offers the goto-sign CTA once cleared and advances to ③ on click', () => {
    const cleared = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={one(cleared)} />);

    // Gate unlocked at ② → the primary "go sign" CTA appears.
    expect(getByTestId('cleared-banner')).toBeTruthy();
    fireEvent.click(getByTestId('goto-sign'));
    expect(getByTestId('signing-card')).toBeTruthy();
  });

  it('triages queue chips: pending (with hit count) vs no-work', () => {
    const items = many(
      makeReport([
        makeFinding({ id: 'a', disposition: 'pending' }),
        makeFinding({ id: 'b', disposition: 'pending' }),
      ]),
      makeReport([makeFinding({ id: 'c', disposition: 'replace' })]),
    );
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);

    const chip1 = getByTestId('queue-item-1');
    expect(chip1.getAttribute('data-state')).toBe('待处置');
    expect(chip1.textContent).toContain('·2'); // hit-count badge
    expect(getByTestId('queue-item-2').getAttribute('data-state')).toBe('无需处置');
  });

  it('queue-clean-all cleans unsigned sessions and skips signed ones', async () => {
    const item1 = makeReport([makeFinding({ id: 'a', disposition: 'replace' })]); // cleared → signable
    const cleaned2 = makeReport([makeFinding({ id: 'b', ruleId: 'aws-access-token', disposition: 'replace' })]);
    const batch = vi.fn(async (_reviewId: string, _by: string, _key: string, _disp: string) => ({
      report: cleaned2,
      gate: cleaned2.gate,
    }));
    const items = many(
      item1,
      makeReport([makeFinding({ id: 'b', ruleId: 'aws-access-token', disposition: 'pending' })]),
    );
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={items} />);

    // Sign session 1, auto-advancing to session 2 (session 1 now signed).
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('sign-checkbox'));
    fireEvent.click(getByTestId('sign-submit'));

    // The queue-level clean button appears (only session 2 has a cleanable hit).
    fireEvent.click(getByTestId('queue-clean-all'));
    await waitFor(() => expect(batch).toHaveBeenCalledWith('r2', 'rule', 'aws-access-token', 'replace'));
    // The signed session (r1) is skipped entirely.
    expect(batch.mock.calls.some((c) => c[0] === 'r1')).toBe(false);
  });
});
