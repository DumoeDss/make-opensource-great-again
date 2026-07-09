// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { PublishPlan, PublishPreflight } from '../api/types';
import { ExitCards } from '../components/journey/ExitCards';
import { makeReport } from './_fixtures';

afterEach(cleanup);

const PLAN: PublishPlan = {
  branch: 'contrib/USER_1/sess-x',
  targetBranch: 'main',
  recordPath: 'data/0.1.0/USER_1/sess-x.jsonl',
  provenancePath: 'data/0.1.0/USER_1/sess-x.provenance.json',
  prTitle: 'Add sanitized session sess-x',
  prBody: '## Sanitized session contribution\n\none line body',
  commitMessage: 'Add sanitized session sess-x',
  recordCount: 1,
  ghAvailable: false,
  stagedFiles: ['data/0.1.0/USER_1/sess-x.jsonl', 'data/0.1.0/USER_1/sess-x.provenance.json'],
  commands: [
    'git checkout -b contrib/USER_1/sess-x',
    'git add data/0.1.0/USER_1/sess-x.jsonl data/0.1.0/USER_1/sess-x.provenance.json',
    "git commit -m 'Add sanitized session sess-x'",
    'git push -u origin contrib/USER_1/sess-x',
    'gh pr create --base main --head contrib/USER_1/sess-x --title ... --body-file .mosga-pr-body.md',
  ],
  provenance: {},
  engine: {},
  compareUrl: 'https://github.com/mosga/data/compare/main...contrib/USER_1/sess-x?expand=1',
  recordBytes: 321,
  contentHash: 'a'.repeat(64),
};

const READY: PublishPreflight = {
  dataRepoConfigured: true,
  gitAvailable: true,
  ghAvailable: true,
  ghAuthenticated: true,
  repoClean: true,
};

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
    getPreflight: vi.fn(async () => READY),
    publishPlan: vi.fn(async () => ({ ok: true as const, plan: PLAN })),
    publishStage: vi.fn(async () => ({
      ok: true as const,
      result: { staged: true as const, branch: PLAN.branch, stagedFiles: PLAN.stagedFiles, recordPath: PLAN.recordPath },
    })),
    publishSubmit: vi.fn(async () => ({
      ok: true as const,
      result: {
        opened: true as const,
        branch: PLAN.branch,
        receipt: {
          branch: PLAN.branch,
          targetBranch: 'main',
          prTitle: PLAN.prTitle,
          compareUrl: PLAN.compareUrl,
          submittedAt: '2026-07-09T00:00:00.000Z',
        },
      },
    })),
    ...over,
  } as ApiClient;
}

function renderCard(client: ApiClient, onPublished = vi.fn(), onJumpToRule = vi.fn()): ReturnType<typeof render> {
  const report = makeReport([]);
  return render(
    <ExitCards
      client={client}
      reviewId="r1"
      gate={report.gate}
      exported={null}
      onExport={vi.fn()}
      onSubmitted={vi.fn()}
      onPublished={onPublished}
      onJumpToRule={onJumpToRule}
    />,
  );
}

describe('ExitCards 出口① preflight card', () => {
  it('shows 需配置 (disabled) when no data repo is configured', async () => {
    const client = fakeClient({ getPreflight: vi.fn(async () => ({ ...READY, dataRepoConfigured: false })) });
    const { getByTestId } = renderCard(client);
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('需配置'));
    expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows 缺依赖 (disabled) when git is missing or the repo is dirty', async () => {
    const client = fakeClient({ getPreflight: vi.fn(async () => ({ ...READY, repoClean: false })) });
    const { getByTestId } = renderCard(client);
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('缺依赖'));
    expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows gh未登录 (enabled, manual path) when gh is present but unauthenticated', async () => {
    const client = fakeClient({ getPreflight: vi.fn(async () => ({ ...READY, ghAuthenticated: false })) });
    const { getByTestId } = renderCard(client);
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('gh未登录'));
    expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows 就绪 (enabled) when everything is ready', async () => {
    const client = fakeClient();
    const { getByTestId } = renderCard(client);
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('就绪'));
    expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('PublishWizard flow', () => {
  it('runs 预检 → 预览 → 提交 with a one-click submit that completes the journey', async () => {
    const onPublished = vi.fn();
    const client = fakeClient(); // gh ready → one-click
    const { getByTestId, findByTestId } = renderCard(client, onPublished);

    await waitFor(() => expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('exit-one-cta'));

    // 预检 runs on mount → advances to the PR 预览 step.
    await findByTestId('wizard-step-preview');
    expect(getByTestId('preview-branch').textContent).toContain('contrib/USER_1/sess-x');
    expect(getByTestId('preview-pr-body').textContent).toContain('Sanitized session contribution');

    fireEvent.click(getByTestId('wizard-to-submit'));
    // gh ready → one-click submit.
    const submitBtn = await findByTestId('wizard-submit-btn');
    fireEvent.click(submitBtn);

    await findByTestId('published-badge');
    expect(client.publishSubmit).toHaveBeenCalledWith('r1');
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('gh-free path stages to disk then renders the commands + compare fallback', async () => {
    const client = fakeClient({
      getPreflight: vi.fn(async () => ({ ...READY, ghAvailable: false, ghAuthenticated: false })),
      publishPlan: vi.fn(async () => ({ ok: true as const, plan: { ...PLAN, ghAvailable: false } })),
    });
    const { getByTestId, findByTestId } = renderCard(client);

    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('就绪'));
    fireEvent.click(getByTestId('exit-one-cta'));

    await findByTestId('wizard-step-preview');
    fireEvent.click(getByTestId('wizard-to-submit'));

    // gh-free → an explicit stage button, then the manual fallback.
    const stageBtn = await findByTestId('wizard-stage-btn');
    fireEvent.click(stageBtn);

    await findByTestId('manual-fallback');
    expect(getByTestId('staged-locations').textContent).toContain('data/0.1.0/USER_1/sess-x.jsonl');
    expect(getByTestId('manual-commands').textContent).toContain('gh pr create');
    expect(getByTestId('manual-compare-link').getAttribute('href')).toBe(PLAN.compareUrl);
    expect(client.publishStage).toHaveBeenCalledWith('r1');
  });

  it('precheck_refused shows the rule-aggregated reasons and fires the jump callback', async () => {
    const onJumpToRule = vi.fn();
    const client = fakeClient({
      publishPlan: vi.fn(async () => ({
        ok: false as const,
        error: 'refused',
        code: 'precheck_refused',
        blockingByRule: [{ ruleId: 'aws-access-token', count: 2 }],
      })),
    });
    const { getByTestId, findByTestId } = renderCard(client, vi.fn(), onJumpToRule);

    await waitFor(() => expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('exit-one-cta'));

    await findByTestId('precheck-refused');
    expect(getByTestId('precheck-refused').textContent).toContain('aws-access-token');
    fireEvent.click(getByTestId('jump-to-rule-aws-access-token'));
    expect(onJumpToRule).toHaveBeenCalledWith('aws-access-token');
  });
});
