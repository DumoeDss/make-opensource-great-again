// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { QueueItem, SanitizationReport, SessionRef } from '../api/types';
import { ReviewView } from '../components/ReviewView';
import { makeFinding, makeNonText, makeReport } from './_fixtures';

afterEach(cleanup);

const READY = {
  dataRepoConfigured: true,
  gitAvailable: true,
  ghAvailable: true,
  ghAuthenticated: true,
  repoClean: true,
};

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

function one(report: SanitizationReport): QueueItem[] {
  return [{ review: { reviewId: 'r1', report, rulesetWarnings: [] }, ref: makeRef() }];
}

function many(...reports: SanitizationReport[]): QueueItem[] {
  return reports.map((report, i) => ({
    review: { reviewId: `r${i + 1}`, report, rulesetWarnings: [] },
    ref: makeRef({ id: `sess${i + 1}`, title: `Session ${i + 1}` }),
  }));
}

/** An `exportReview` mock returning an OK stamped session (shape loosened for tests). */
function okExport() {
  return vi.fn(async () => ({
    ok: true as const,
    data: {
      session: {
        meta: { sanitized: true, sanitizationRulesetVersion: 'gitleaks@x', contributorAlias: 'USER_1' },
        session: {},
        messages: [],
      },
      gate: { blockingTotal: 0, blockingPending: 0, nonTextPending: 0, unlocked: true },
    },
  })) as unknown as ApiClient['exportReview'];
}

const cf = () => makeFinding({ id: 'fx', disposition: 'replace' });

describe('ReviewView disposition step', () => {
  it('dispositioning a finding calls the client and gates the exit until cleared', async () => {
    const initial = makeReport([makeFinding({ id: 'fx', disposition: 'pending' })]);
    const next = makeReport([makeFinding({ id: 'fx', disposition: 'replace' })]);
    const setDisposition = vi.fn(async () => ({ report: next, gate: next.gate }));
    const { getByTestId } = render(<ReviewView client={fakeClient({ setDisposition })} items={one(initial)} />);

    expect(getByTestId('lock-badge').textContent).toContain('还差 1');
    expect((getByTestId('goto-step-3') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByTestId('disp-fx-replace'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'replace');

    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已解锁'));
    expect((getByTestId('goto-step-3') as HTMLButtonElement).disabled).toBe(false);
  });

  it('batch-by-rule delegates to the client', async () => {
    const initial = makeReport([makeFinding({ id: 'a' }), makeFinding({ id: 'b' })]);
    const batch = vi.fn(async () => ({ report: initial, gate: initial.gate }));
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={one(initial)} />);
    fireEvent.click(getByTestId('batch-rule-aws-access-token'));
    await waitFor(() => expect(batch).toHaveBeenCalledWith('r1', 'rule', 'aws-access-token', 'replace'));
  });

  it('confirming a non-text item decrements the remaining count', async () => {
    const initial = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'pending' })]);
    const next = makeReport([], [makeNonText({ messageUuid: 'm1', disposition: 'keep' })]);
    const setNonText = vi.fn(async () => ({ report: next, gate: next.gate }));
    const { getByTestId } = render(<ReviewView client={fakeClient({ setNonText })} items={one(initial)} />);
    expect(getByTestId('lock-badge').textContent).toContain('还差 1');
    fireEvent.click(getByTestId('group-nontext'));
    fireEvent.click(getByTestId('nontext-keep-m1'));
    expect(setNonText).toHaveBeenCalledWith('r1', 'm1', 'keep');
    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已解锁'));
  });

  it('one-click clean replaces each pending non-meta rule once, never the meta hits', async () => {
    const report = makeReport([
      makeFinding({ id: 'fx', ruleId: 'aws-access-token', disposition: 'pending' }),
      makeFinding({ id: 'fy', ruleId: 'aws-access-token', disposition: 'pending' }),
      makeFinding({ id: 'meta1', ruleId: 'redos-guard', disposition: 'pending' }),
    ]);
    const cleaned = makeReport([
      makeFinding({ id: 'fx', ruleId: 'aws-access-token', disposition: 'replace' }),
      makeFinding({ id: 'fy', ruleId: 'aws-access-token', disposition: 'replace' }),
      makeFinding({ id: 'meta1', ruleId: 'redos-guard', disposition: 'pending' }),
    ]);
    const batch = vi.fn(async (_r: string, _by: string, _k: string, _d: string) => ({
      report: cleaned,
      gate: cleaned.gate,
    }));
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={one(report)} />);

    expect(getByTestId('clean-all-card').textContent).toContain('2 处');
    fireEvent.click(getByTestId('clean-all'));
    await waitFor(() => expect(batch).toHaveBeenCalledWith('r1', 'rule', 'aws-access-token', 'replace'));
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls.some((c) => c[2] === 'redos-guard')).toBe(false);
  });

  it('offers 前往选择出口 once cleared and advances to the exit step', () => {
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={one(makeReport([cf()]))} />);
    expect(getByTestId('cleared-banner')).toBeTruthy();
    fireEvent.click(getByTestId('goto-exit'));
    expect(getByTestId('exit-cards')).toBeTruthy();
  });
});

describe('ReviewView one-time donation confirmation', () => {
  it('the first exit action opens the affirm dialog; confirming then runs it', async () => {
    const exportReview = okExport();
    const { getByTestId, queryByTestId } = render(
      <ReviewView client={fakeClient({ exportReview })} items={one(makeReport([cf()]))} />,
    );
    fireEvent.click(getByTestId('goto-step-3'));

    fireEvent.click(getByTestId('export-secondary'));
    expect(getByTestId('affirm-dialog')).toBeTruthy();
    expect(exportReview).not.toHaveBeenCalled();

    fireEvent.click(getByTestId('affirm-confirm'));
    await waitFor(() => expect(exportReview).toHaveBeenCalledWith('r1'));
    expect(queryByTestId('affirm-dialog')).toBeNull();
  });

  it('aggregates the summary across every session', () => {
    const items = many(
      makeReport([makeFinding({ id: 'a', disposition: 'replace' })]),
      makeReport([makeFinding({ id: 'b', disposition: 'replace' })]),
    );
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('batch-export-all'));
    expect(getByTestId('summary-sessions').textContent).toBe('2');
    expect(getByTestId('summary-dispositions').textContent).toContain('替换 2');
  });

  it('once affirmed, a later exit action proceeds without re-confirming', async () => {
    const exportReview = okExport();
    const { getByTestId, queryByTestId } = render(
      <ReviewView client={fakeClient({ exportReview })} items={one(makeReport([cf()]))} />,
    );
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('export-secondary'));
    fireEvent.click(getByTestId('affirm-confirm'));
    await waitFor(() => expect(exportReview).toHaveBeenCalledTimes(1));

    fireEvent.click(getByTestId('export-secondary'));
    await waitFor(() => expect(exportReview).toHaveBeenCalledTimes(2));
    expect(queryByTestId('affirm-dialog')).toBeNull();
  });

  it('cancelling the affirm dialog does not run the action', () => {
    const exportReview = okExport();
    const { getByTestId } = render(
      <ReviewView client={fakeClient({ exportReview })} items={one(makeReport([cf()]))} />,
    );
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('export-secondary'));
    fireEvent.click(getByTestId('affirm-cancel'));
    expect(exportReview).not.toHaveBeenCalled();
  });

  it('editing after affirming raises the void confirm and blocks the daemon call', async () => {
    const afterEdit = makeReport([makeFinding({ id: 'fx', disposition: 'delete' })]);
    const setDisposition = vi.fn(async () => ({ report: afterEdit, gate: afterEdit.gate }));
    const exportReview = okExport();
    const { getByTestId } = render(
      <ReviewView client={fakeClient({ setDisposition, exportReview })} items={one(makeReport([cf()]))} />,
    );
    fireEvent.click(getByTestId('goto-step-3'));
    fireEvent.click(getByTestId('export-secondary'));
    fireEvent.click(getByTestId('affirm-confirm'));
    await waitFor(() => expect(exportReview).toHaveBeenCalled());

    fireEvent.click(getByTestId('goto-step-2'));
    fireEvent.click(getByTestId('disp-fx-delete'));
    expect(screen.getByTestId('dialog-confirm')).toBeTruthy();
    expect(setDisposition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dialog-confirm-ok-btn'));
    expect(setDisposition).toHaveBeenCalledWith('r1', 'fx', 'delete');
  });

  it('leaving the journey after a mutation prompts a restart confirm', async () => {
    const onRestart = vi.fn();
    const next = makeReport([cf()]);
    const setDisposition = vi.fn(async () => ({ report: next, gate: next.gate }));
    const { getByTestId } = render(
      <ReviewView
        client={fakeClient({ setDisposition })}
        items={one(makeReport([makeFinding({ id: 'fx', disposition: 'pending' })]))}
        onRestart={onRestart}
      />,
    );
    fireEvent.click(getByTestId('disp-fx-replace'));
    await waitFor(() => expect(setDisposition).toHaveBeenCalled());

    fireEvent.click(getByTestId('restart'));
    expect(screen.getByTestId('restart-confirm')).toBeTruthy();
    expect(onRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('restart-confirm-ok-btn'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewView queue triage + auto-advance (N>1)', () => {
  it('renders a queue bar and triages each session', () => {
    const items = many(makeReport([cf()]), makeReport([makeFinding({ id: 'a' }), makeFinding({ id: 'b' })]));
    const { getByTestId } = render(<ReviewView client={fakeClient()} items={items} />);
    expect(getByTestId('queue-bar').textContent).toContain('会话 1/2');
    expect(getByTestId('queue-item-1').getAttribute('data-state')).toBe('当前');
    expect(getByTestId('queue-item-2').getAttribute('data-state')).toBe('待处置');
    expect(getByTestId('queue-item-2').textContent).toContain('·2');
    expect((getByTestId('goto-step-3') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cleaning the current session auto-advances to the next session with pending work', async () => {
    const cleaned1 = makeReport([makeFinding({ id: 'a', ruleId: 'aws-access-token', disposition: 'replace' })]);
    const batch = vi.fn(async () => ({ report: cleaned1, gate: cleaned1.gate }));
    const items = many(
      makeReport([makeFinding({ id: 'a', ruleId: 'aws-access-token', disposition: 'pending' })]),
      makeReport([makeFinding({ id: 'b', ruleId: 'aws-access-token', disposition: 'pending' })]),
    );
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={items} />);
    fireEvent.click(getByTestId('clean-all'));
    await waitFor(() => expect(getByTestId('queue-bar').textContent).toContain('会话 2/2'));
  });

  it('queue-clean-all clears the whole queue and advances to the exit step', async () => {
    const cleaned = makeReport([makeFinding({ id: 'x', ruleId: 'aws-access-token', disposition: 'replace' })]);
    const batch = vi.fn(async () => ({ report: cleaned, gate: cleaned.gate }));
    const items = many(
      makeReport([makeFinding({ id: 'a', ruleId: 'aws-access-token', disposition: 'pending' })]),
      makeReport([makeFinding({ id: 'b', ruleId: 'aws-access-token', disposition: 'pending' })]),
    );
    const { getByTestId } = render(<ReviewView client={fakeClient({ batch })} items={items} />);
    fireEvent.click(getByTestId('queue-clean-all'));
    await waitFor(() => expect(getByTestId('batch-exit-cards')).toBeTruthy());
  });
});

describe('ReviewView batch exit (N>1)', () => {
  const PLAN = {
    branch: 'contrib/USER_1/batch-abcd1234',
    targetBranch: 'main',
    prTitle: 'Add 2 sanitized sessions (<USER_1>)',
    prBody: '## batch',
    commitMessage: 'Add 2',
    recordCount: 2,
    ghAvailable: true,
    stagedFiles: ['a.jsonl'],
    commands: ['git checkout -b contrib/USER_1/batch-abcd1234'],
    engine: {},
    compareUrl: null,
    totalRecordBytes: 42,
    records: [
      { sessionId: 'sess-a', recordPath: 'a.jsonl', provenancePath: 'a.provenance.json', recordBytes: 21, contentHash: 'a'.repeat(64), messages: 2 },
      { sessionId: 'sess-b', recordPath: 'b.jsonl', provenancePath: 'b.provenance.json', recordBytes: 21, contentHash: 'b'.repeat(64), messages: 3 },
    ],
  };

  const twoCleared = () => many(makeReport([cf()]), makeReport([cf()]));

  it('gates the batch wizard behind the affirm dialog, then a refusal jump stays void-guarded', async () => {
    const setDisposition = vi.fn(async () => {
      const r = makeReport([makeFinding({ id: 'fx', disposition: 'delete' })]);
      return { report: r, gate: r.gate };
    });
    const client = fakeClient({
      setDisposition,
      getPreflight: vi.fn(async () => READY),
      publishBatchPlan: vi.fn(async () => ({
        ok: false as const,
        error: 'refused',
        code: 'precheck_refused',
        blockingBySession: [
          { reviewId: 'r1', sessionId: 'sess-test', blockingByRule: [{ ruleId: 'aws-access-token', count: 1 }] },
        ],
      })),
    });
    const { getByTestId, findByTestId } = render(<ReviewView client={client} items={twoCleared()} />);

    fireEvent.click(getByTestId('goto-step-3'));
    await waitFor(() => expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('batch-exit-one-cta'));
    expect(getByTestId('affirm-dialog')).toBeTruthy();
    fireEvent.click(getByTestId('affirm-confirm'));

    const jump = await findByTestId('jump-to-session-r1-aws-access-token');
    fireEvent.click(jump);
    expect(getByTestId('queue-bar').textContent).toContain('会话 1/2');

    fireEvent.click(getByTestId('disp-fx-delete'));
    expect(screen.getByTestId('dialog-confirm')).toBeTruthy();
    expect(setDisposition).not.toHaveBeenCalled();
  });

  it('a successful batch publish marks the journey 已完成', async () => {
    const client = fakeClient({
      getPreflight: vi.fn(async () => READY),
      publishBatchPlan: vi.fn(async () => ({ ok: true as const, plan: PLAN })),
      publishBatchSubmit: vi.fn(async () => ({
        ok: true as const,
        result: {
          opened: true as const,
          branch: PLAN.branch,
          receipt: { branch: PLAN.branch, targetBranch: 'main', prTitle: PLAN.prTitle, compareUrl: null, submittedAt: 'x', recordCount: 2 },
        },
      })),
    });
    const { getByTestId, findByTestId } = render(<ReviewView client={client} items={twoCleared()} />);

    fireEvent.click(getByTestId('goto-step-3'));
    await waitFor(() => expect((getByTestId('batch-exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('batch-exit-one-cta'));
    fireEvent.click(getByTestId('affirm-confirm'));
    await findByTestId('batch-wizard-step-preview');
    fireEvent.click(getByTestId('batch-wizard-to-submit'));
    fireEvent.click(await findByTestId('batch-wizard-submit-btn'));

    await findByTestId('batch-published-badge');
    expect(client.publishBatchSubmit).toHaveBeenCalledWith(['r1', 'r2']);
    await waitFor(() => expect(getByTestId('lock-badge').textContent).toContain('已完成'));
  });
});
