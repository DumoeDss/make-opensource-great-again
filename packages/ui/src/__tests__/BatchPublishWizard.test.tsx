// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { PublishBatchPlan } from '../api/types';
import { BatchPublishWizard } from '../components/journey/BatchPublishWizard';

afterEach(cleanup);

const PLAN: PublishBatchPlan = {
  branch: 'contrib/USER_1/batch-abcd1234',
  targetBranch: 'main',
  prTitle: 'Add 2 sanitized sessions (<USER_1>)',
  prBody: '## Sanitized sessions contribution (batch)\n\ntable here',
  commitMessage: 'Add 2 sanitized sessions',
  recordCount: 2,
  ghAvailable: true,
  stagedFiles: ['data/s1.jsonl', 'data/s1.provenance.json', 'data/s2.jsonl', 'data/s2.provenance.json'],
  commands: [
    'git checkout -b contrib/USER_1/batch-abcd1234',
    'git add data/s1.jsonl data/s2.jsonl',
    'git push -u origin contrib/USER_1/batch-abcd1234',
    'gh pr create --base main --head contrib/USER_1/batch-abcd1234 --title ... --body-file .mosga-pr-body.md',
  ],
  engine: {},
  compareUrl: 'https://github.com/mosga/data/compare/main...contrib/USER_1/batch-abcd1234?expand=1',
  totalRecordBytes: 640,
  records: [
    { sessionId: 's1', recordPath: 'data/s1.jsonl', provenancePath: 'data/s1.provenance.json', recordBytes: 320, contentHash: 'a'.repeat(64), messages: 4 },
    { sessionId: 's2', recordPath: 'data/s2.jsonl', provenancePath: 'data/s2.provenance.json', recordBytes: 320, contentHash: 'b'.repeat(64), messages: 6 },
  ],
};

function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    publishBatchPlan: vi.fn(async () => ({ ok: true as const, plan: PLAN })),
    publishBatchStage: vi.fn(async () => ({
      ok: true as const,
      result: { staged: true as const, branch: PLAN.branch, stagedFiles: PLAN.stagedFiles, recordCount: 2 },
    })),
    publishBatchSubmit: vi.fn(async () => ({
      ok: true as const,
      result: {
        opened: true as const,
        branch: PLAN.branch,
        receipt: {
          branch: PLAN.branch,
          targetBranch: 'main',
          prTitle: PLAN.prTitle,
          compareUrl: PLAN.compareUrl,
          submittedAt: '2026-07-10T00:00:00.000Z',
          recordCount: 2,
        },
      },
    })),
    ...over,
  } as ApiClient;
}

const REVIEW_IDS = ['r1', 'r2'];

describe('BatchPublishWizard', () => {
  it('plans and shows the per-record preview table + branch', async () => {
    const { getByTestId, findByTestId } = render(
      <BatchPublishWizard client={fakeClient()} reviewIds={REVIEW_IDS} ghReady onPublished={vi.fn()} onJumpToSession={vi.fn()} />,
    );
    await findByTestId('batch-wizard-step-preview');
    expect(getByTestId('batch-preview-branch').textContent).toContain('contrib/USER_1/batch-abcd1234');
    expect(getByTestId('preview-records')).toBeTruthy();
    expect(getByTestId('preview-record-s1')).toBeTruthy();
    expect(getByTestId('preview-record-s2').textContent).toContain('data/s2.jsonl');
    expect(getByTestId('batch-preview-pr-body').textContent).toContain('Sanitized sessions contribution');
  });

  it('groups a precheck refusal by session and fires the jump callback', async () => {
    const onJumpToSession = vi.fn();
    const client = fakeClient({
      publishBatchPlan: vi.fn(async () => ({
        ok: false as const,
        error: 'refused',
        code: 'precheck_refused',
        blockingBySession: [
          { reviewId: 'r1', sessionId: 's1', blockingByRule: [{ ruleId: 'aws-access-token', count: 2 }] },
          { reviewId: 'r2', sessionId: 's2', blockingByRule: [{ ruleId: 'github-pat', count: 1 }] },
        ],
      })),
    });
    const { getByTestId, findByTestId } = render(
      <BatchPublishWizard client={client} reviewIds={REVIEW_IDS} ghReady onPublished={vi.fn()} onJumpToSession={onJumpToSession} />,
    );
    await findByTestId('batch-precheck-refused');
    expect(getByTestId('refused-session-s1').textContent).toContain('aws-access-token');
    expect(getByTestId('refused-session-s2').textContent).toContain('github-pat');
    fireEvent.click(getByTestId('jump-to-session-r1-aws-access-token'));
    expect(onJumpToSession).toHaveBeenCalledWith('r1', 'aws-access-token');
  });

  it('one-click submits when gh is ready → published badge + onPublished', async () => {
    const onPublished = vi.fn();
    const client = fakeClient();
    const { getByTestId, findByTestId } = render(
      <BatchPublishWizard client={client} reviewIds={REVIEW_IDS} ghReady onPublished={onPublished} onJumpToSession={vi.fn()} />,
    );
    await findByTestId('batch-wizard-step-preview');
    fireEvent.click(getByTestId('batch-wizard-to-submit'));
    fireEvent.click(await findByTestId('batch-wizard-submit-btn'));
    await findByTestId('batch-published-badge');
    expect(client.publishBatchSubmit).toHaveBeenCalledWith(REVIEW_IDS);
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('gh-free path stages then renders the manual fallback commands', async () => {
    const client = fakeClient({
      publishBatchPlan: vi.fn(async () => ({ ok: true as const, plan: { ...PLAN, ghAvailable: false } })),
    });
    const { getByTestId, findByTestId } = render(
      <BatchPublishWizard client={client} reviewIds={REVIEW_IDS} ghReady={false} onPublished={vi.fn()} onJumpToSession={vi.fn()} />,
    );
    await findByTestId('batch-wizard-step-preview');
    fireEvent.click(getByTestId('batch-wizard-to-submit'));
    fireEvent.click(await findByTestId('batch-wizard-stage-btn'));
    await findByTestId('batch-manual-fallback');
    expect(getByTestId('batch-staged-locations').textContent).toContain('data/s1.jsonl');
    expect(getByTestId('batch-manual-commands').textContent).toContain('gh pr create');
    expect(client.publishBatchStage).toHaveBeenCalledWith(REVIEW_IDS);
  });

  it('surfaces branch_exists / publish_in_flight error text on submit', async () => {
    const client = fakeClient({
      publishBatchSubmit: vi.fn(async () => ({
        ok: false as const,
        error: 'the contribution branch already exists',
        code: 'branch_exists',
        branch: 'contrib/USER_1/batch-abcd1234',
      })),
    });
    const { getByTestId, findByTestId } = render(
      <BatchPublishWizard client={client} reviewIds={REVIEW_IDS} ghReady onPublished={vi.fn()} onJumpToSession={vi.fn()} />,
    );
    await findByTestId('batch-wizard-step-preview');
    fireEvent.click(getByTestId('batch-wizard-to-submit'));
    fireEvent.click(await findByTestId('batch-wizard-submit-btn'));
    await waitFor(() => expect(getByTestId('batch-wizard-error').textContent).toContain('contrib/USER_1/batch-abcd1234'));
  });
});
