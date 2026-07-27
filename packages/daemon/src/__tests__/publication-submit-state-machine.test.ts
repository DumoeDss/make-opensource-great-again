import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SanitizedSession } from '@mosga/contracts';
import { compileRuleset } from '@mosga/sanitizer';
import { afterEach, describe, expect, it } from 'vitest';

import { ReviewStore } from '../reviews.js';
import {
  GitHubAdapterError,
  GitHubPublicationService,
  FilePublicationJournalStore,
  FilePublicationReceiptStore,
  InMemoryPublicationJournalStore,
  InMemoryPublicationLock,
  InMemoryPublicationReceiptStore,
  InMemoryPublicationTargetStore,
  InMemorySealedPreviewStore,
  PublicationError,
  PublicationSubmitStateMachine,
  RecordingGitHubPort,
  SubmitPreflight,
  type GitCommitIdentity,
  type GitWorkspacePort,
  type PrepareWorkspaceInput,
  type PreparedWorkspace,
  type PublicationJournal,
  type PublicationJournalStore,
  type PublicationReceipt,
  type PublicationReceiptStore,
  type PushResult,
  type RecoverWorkspaceInput,
} from '../publication/index.js';

const generatedAt = '2026-07-27T00:00:00.000Z';
const ruleset = compileRuleset({ generatedAt });
const commitIdentity = {
  commitSha: 'c'.repeat(40),
  treeSha: 'd'.repeat(40),
};
const tempRoots: string[] = [];

function tempRoot(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mosga-publication-recovery-'),
  );
  tempRoots.push(value);
  return value;
}

afterEach(() => {
  for (const value of tempRoots.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

function session(id = 'session'): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'codex',
      toolVersion: '1.0.0',
      sanitizationRulesetVersion: 'rules',
      exportedAt: generatedAt,
      license: 'CC-BY-4.0',
      sanitized: true,
    },
    session: {
      sessionId: id,
      sourceId: id,
      projectKey: 'project',
      cwd: null,
      title: null,
      updatedAt: 1,
    },
    messages: [
      {
        sdkUuid: `message-${id}`,
        parentUuid: null,
        role: 'user',
        content: 'clean publication content',
        sdkMessageType: 'message',
        timestamp: 1,
      },
    ],
  };
}

class RecordingWorkspace implements GitWorkspacePort {
  readonly calls: string[] = [];
  readonly preparedInputs: PrepareWorkspaceInput[] = [];
  readonly recoveredInputs: RecoverWorkspaceInput[] = [];
  pushResults: PushResult[] = [{ state: 'pushed', ...commitIdentity }];
  failOnceAt?: 'prepare' | 'push';

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    this.calls.push('prepare');
    this.preparedInputs.push(structuredClone(input));
    if (this.failOnceAt === 'prepare') {
      this.failOnceAt = undefined;
      throw new PublicationError({
        code: 'workspace_unavailable',
        phase: 'workspace',
        message: 'Publication recovery storage is unavailable.',
        retryable: true,
      });
    }
    return this.workspace(input);
  }

  async recover(input: RecoverWorkspaceInput): Promise<PreparedWorkspace> {
    this.calls.push('recover');
    this.recoveredInputs.push(structuredClone(input));
    return this.workspace(input);
  }

  async write(): Promise<void> {
    this.calls.push('write');
  }

  async commit(): Promise<GitCommitIdentity> {
    this.calls.push('commit');
    return commitIdentity;
  }

  async push(): Promise<PushResult> {
    this.calls.push('push');
    if (this.failOnceAt === 'push') {
      this.failOnceAt = undefined;
      throw new PublicationError({
        code: 'push_rejected',
        phase: 'push',
        message: 'The contribution branch could not be pushed.',
        retryable: true,
      });
    }
    return this.pushResults.shift() ?? { state: 'adopted', ...commitIdentity };
  }

  private workspace(input: PrepareWorkspaceInput): PreparedWorkspace {
    return {
      paths: {
        root: input.managedRoot,
        cache: 'private-cache',
        worktree: 'private-worktree',
        marker: 'private-marker',
      },
      marker: {
        schemaVersion: 1,
        publicationRef: input.publicationRef,
        repositoryId: input.repositoryId,
      },
      baseCommitSha: input.baseCommitSha,
      branch: input.branch,
    };
  }
}

class RecordingJournalStore implements PublicationJournalStore {
  readonly phases: PublicationJournal['phase'][] = [];
  failOnceAt?: PublicationJournal['phase'];

  constructor(
    readonly inner: PublicationJournalStore =
      new InMemoryPublicationJournalStore(),
  ) {}

  async read(publicationRef: string): Promise<PublicationJournal | null> {
    return this.inner.read(publicationRef);
  }

  async write(journal: PublicationJournal): Promise<PublicationJournal> {
    if (this.failOnceAt === journal.phase) {
      this.failOnceAt = undefined;
      throw new PublicationError({
        code: 'workspace_unavailable',
        phase: 'workspace',
        message: 'Publication recovery storage is unavailable.',
        retryable: true,
      });
    }
    const stored = await this.inner.write(journal);
    this.phases.push(stored.phase);
    return stored;
  }
}

class RecoveringGitHubPort extends RecordingGitHubPort {
  loseCreateResponse = false;

  override async ensureFork(input: Parameters<RecordingGitHubPort['ensureFork']>[0]) {
    const fork = await super.ensureFork(input);
    this.state.fork = structuredClone(fork);
    return fork;
  }

  override async createPullRequest(
    input: Parameters<RecordingGitHubPort['createPullRequest']>[0],
  ) {
    const pullRequest = await super.createPullRequest(input);
    this.state.pullRequest = structuredClone(pullRequest);
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false;
      throw new GitHubAdapterError('write_failed');
    }
    return pullRequest;
  }
}

interface Fixture {
  targetStore: InMemoryPublicationTargetStore;
  previews: InMemorySealedPreviewStore;
  receipts: PublicationReceiptStore;
  journals: RecordingJournalStore;
  github: RecoveringGitHubPort;
  workspace: RecordingWorkspace;
  request: {
    publicationRef: string;
    targetRevision: number;
    contentDigest: string;
    confirmPublic: true;
  };
  machine: PublicationSubmitStateMachine;
}

async function fixture(
  route: 'direct' | 'existing-fork' | 'on-submit-fork' = 'direct',
  persistenceRoot?: string,
): Promise<Fixture> {
  const targetStore = new InMemoryPublicationTargetStore();
  await targetStore.configure({ owner: 'owner', repo: 'repo' });
  const reviews = new ReviewStore();
  const reviewId = reviews.create(session(), ruleset, { generatedAt }).reviewId;
  const github = new RecoveringGitHubPort(
    route === 'direct'
      ? {}
      : {
          repository: {
            id: 'R_upstream',
            slug: 'owner/repo',
            url: 'https://github.com/owner/repo',
            visibility: 'public',
            defaultBranch: 'main',
            defaultHeadSha: 'a'.repeat(40),
            viewerPermission: 'READ',
          },
          fork:
            route === 'existing-fork'
              ? {
                  id: 'R_fork',
                  slug: 'actor/repo',
                  url: 'https://github.com/actor/repo',
                  owner: 'actor',
                  sourceRepositoryId: 'R_upstream',
                }
              : null,
        },
  );
  const previews = new InMemorySealedPreviewStore({
    id: () => 'publication_1',
    now: () => new Date(generatedAt),
  });
  const service = new GitHubPublicationService({
    targetStore,
    previews,
    github,
    reviews,
    ruleset,
    compilerOptions: { generatedAt },
  });
  const preview = await service.preview({ reviewIds: [reviewId] });
  const receipts = persistenceRoot
    ? new FilePublicationReceiptStore(path.join(persistenceRoot, 'receipts'))
    : new InMemoryPublicationReceiptStore();
  const journals = new RecordingJournalStore(
    persistenceRoot
      ? new FilePublicationJournalStore(path.join(persistenceRoot, 'journals'))
      : new InMemoryPublicationJournalStore(),
  );
  const workspace = new RecordingWorkspace();
  const preflight = new SubmitPreflight({
    receipts,
    previews,
    targets: targetStore,
    reviews,
    github,
    currentRuleset: () => ruleset,
  });
  const machine = new PublicationSubmitStateMachine({
    preflight,
    journals,
    receipts,
    previews,
    lock: new InMemoryPublicationLock(),
    workspace,
    github,
    managedRoot: 'private-managed-root',
    now: () => new Date('2026-07-27T00:01:00.000Z'),
    waitForFork: async () => undefined,
  });
  return {
    targetStore,
    previews,
    receipts,
    journals,
    github,
    workspace,
    machine,
    request: {
      publicationRef: preview.publicationRef,
      targetRevision: preview.target.revision,
      contentDigest: preview.contribution.contentDigest,
      confirmPublic: true,
    },
  };
}

async function freshMachine(
  value: Fixture,
  persistenceRoot: string,
): Promise<PublicationSubmitStateMachine> {
  const movedTarget = new InMemoryPublicationTargetStore();
  await movedTarget.configure({ owner: 'different', repo: 'target' });
  const receipts = new FilePublicationReceiptStore(
    path.join(persistenceRoot, 'receipts'),
  );
  const journals = new FilePublicationJournalStore(
    path.join(persistenceRoot, 'journals'),
  );
  const emptyReviews = new ReviewStore();
  const emptyPreviews = new InMemorySealedPreviewStore();
  const preflight = new SubmitPreflight({
    receipts,
    previews: emptyPreviews,
    targets: movedTarget,
    reviews: emptyReviews,
    github: value.github,
    currentRuleset: () => ruleset,
  });
  return new PublicationSubmitStateMachine({
    preflight,
    journals,
    receipts,
    previews: emptyPreviews,
    lock: new InMemoryPublicationLock(),
    workspace: value.workspace,
    github: value.github,
    managedRoot: 'private-managed-root',
    now: () => new Date('2026-07-27T00:02:00.000Z'),
    waitForFork: async () => undefined,
  });
}

function writeCount(value: Fixture, operation: string): number {
  return value.github.calls.filter((call) => call.operation === operation).length;
}

describe('journaled publication submit state machine', () => {
  it.each([
    ['direct', 'owner/repo', 0],
    ['existing-fork', 'actor/repo', 0],
    ['on-submit-fork', 'actor/repo', 1],
  ] as const)(
    'delivers the %s route through every monotonic phase',
    async (route, pushRepository, ensureCount) => {
      const value = await fixture(route);
      const receipt = await value.machine.submit(value.request);
      expect(value.journals.phases).toEqual([
        'validated',
        'committed',
        'fork_ready',
        'pushed',
        'pr_observed',
        'completed',
      ]);
      expect(receipt).toMatchObject({
        publicationRef: 'publication_1',
        upstream: 'owner/repo',
        pushRepository,
        mode: route === 'direct' ? 'direct' : 'fork',
        baseBranch: 'main',
        baseCommitSha: 'a'.repeat(40),
        branch: expect.stringMatching(/^contrib\//),
        commitSha: commitIdentity.commitSha,
        prNumber: 1,
        prUrl: 'https://github.com/owner/repo/pull/1',
        recordCount: 1,
        contentDigest: value.request.contentDigest,
      });
      expect(writeCount(value, 'ensureFork')).toBe(ensureCount);
      expect(writeCount(value, 'createPullRequest')).toBe(1);
      expect(value.workspace.preparedInputs[0]).toMatchObject({
        upstreamRemote: 'https://github.com/owner/repo.git',
        pushRemote: `https://github.com/${pushRepository}.git`,
      });
      const serialized = JSON.stringify(receipt);
      for (const forbidden of [
        'private-managed-root',
        'private-worktree',
        'contents',
        'command',
        'token',
        'stderr',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(() => value.previews.get(value.request.publicationRef)).toThrow();
    },
  );

  it('recovers a committed on-submit fork without creating it twice', async () => {
    const value = await fixture('on-submit-fork');
    value.journals.failOnceAt = 'fork_ready';
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    expect(writeCount(value, 'ensureFork')).toBe(1);
    const receipt = await value.machine.submit(value.request);
    expect(receipt.prNumber).toBe(1);
    expect(writeCount(value, 'ensureFork')).toBe(1);
    expect(writeCount(value, 'createPullRequest')).toBe(1);
    expect(value.workspace.calls).toContain('recover');
  });

  it('adopts a same-tree push after the pushed journal transition was lost', async () => {
    const value = await fixture();
    value.workspace.pushResults = [
      { state: 'pushed', ...commitIdentity },
      { state: 'adopted', ...commitIdentity },
    ];
    value.journals.failOnceAt = 'pushed';
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    const receipt = await value.machine.submit(value.request);
    expect(receipt.prNumber).toBe(1);
    expect(value.workspace.calls.filter((call) => call === 'push')).toHaveLength(2);
    expect(writeCount(value, 'createPullRequest')).toBe(1);
  });

  it('records the actual remote commit when adopting an equal tree', async () => {
    const value = await fixture();
    const remoteCommitSha = 'e'.repeat(40);
    value.workspace.pushResults = [
      {
        state: 'adopted',
        commitSha: remoteCommitSha,
        treeSha: commitIdentity.treeSha,
      },
    ];
    const receipt = await value.machine.submit(value.request);
    expect(receipt.commitSha).toBe(remoteCommitSha);
    expect(
      (await value.journals.read(value.request.publicationRef))?.commitSha,
    ).toBe(remoteCommitSha);
  });

  it('finds the exact PR after create succeeded but its response was lost', async () => {
    const value = await fixture('existing-fork');
    value.github.loseCreateResponse = true;
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'pr_create_failed' },
    });
    const receipt = await value.machine.submit(value.request);
    expect(receipt.prNumber).toBe(1);
    expect(writeCount(value, 'createPullRequest')).toBe(1);
    expect(writeCount(value, 'findPullRequest')).toBe(2);
  });

  it('does not journal a PR response that is not bound to the sealed upstream', async () => {
    const value = await fixture();
    value.github.state.pullRequest = {
      number: 1,
      url: 'https://github.com/attacker/repo/pull/1',
    };
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'pr_create_failed' },
    });
    expect(
      (await value.journals.read(value.request.publicationRef))?.phase,
    ).toBe('pushed');
    expect(writeCount(value, 'createPullRequest')).toBe(0);
  });

  it('returns an immutable receipt and finishes a receipt-written journal retry', async () => {
    const value = await fixture();
    value.journals.failOnceAt = 'completed';
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    const persisted = await value.receipts.read(value.request.publicationRef);
    expect(persisted).not.toBeNull();
    const retry = await value.machine.submit(value.request);
    expect(retry).toEqual(persisted);
    expect((await value.journals.read(value.request.publicationRef))?.phase).toBe(
      'completed',
    );
    expect(writeCount(value, 'createPullRequest')).toBe(1);
  });

  it('uses the sealed target after proven push even when configuration changes', async () => {
    const value = await fixture();
    value.journals.failOnceAt = 'pr_observed';
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    await value.targetStore.configure({ owner: 'different', repo: 'target' });
    const receipt = await value.machine.submit(value.request);
    expect(receipt).toMatchObject({
      upstream: 'owner/repo',
      pushRepository: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    expect(writeCount(value, 'createPullRequest')).toBe(1);
  });

  it.each([
    ['validated', 'prepare'],
    ['committed', 'fork_ready_transition'],
    ['fork_ready', 'push'],
    ['push_success_before_transition', 'pushed_transition'],
  ] as const)(
    'recovers %s from durable seal with a fresh empty review process',
    async (_phase, interruption) => {
      const persistenceRoot = tempRoot();
      const value = await fixture('direct', persistenceRoot);
      if (interruption === 'prepare') {
        value.workspace.failOnceAt = 'prepare';
      } else if (interruption === 'fork_ready_transition') {
        value.journals.failOnceAt = 'fork_ready';
      } else if (interruption === 'push') {
        value.workspace.failOnceAt = 'push';
      } else {
        value.workspace.pushResults = [
          { state: 'pushed', ...commitIdentity },
          { state: 'adopted', ...commitIdentity },
        ];
        value.journals.failOnceAt = 'pushed';
      }

      await expect(value.machine.submit(value.request)).rejects.toBeInstanceOf(
        PublicationError,
      );
      const durableBeforeRestart = await new FilePublicationJournalStore(
        path.join(persistenceRoot, 'journals'),
      ).read(value.request.publicationRef);
      expect(durableBeforeRestart?.phase).toBe(
        interruption === 'prepare'
          ? 'validated'
          : interruption === 'fork_ready_transition'
            ? 'committed'
            : 'fork_ready',
      );

      const restarted = await freshMachine(value, persistenceRoot);
      const receipt = await restarted.submit(value.request);
      expect(receipt).toMatchObject({
        upstream: 'owner/repo',
        pushRepository: 'owner/repo',
        contentDigest: value.request.contentDigest,
        prNumber: 1,
      });
      expect(
        await new FilePublicationReceiptStore(
          path.join(persistenceRoot, 'receipts'),
        ).read(value.request.publicationRef),
      ).toEqual(receipt);
    },
  );

  it('refuses a different-tree branch without a PR create', async () => {
    const value = await fixture();
    value.workspace.pushResults = [{ state: 'conflict' }];
    await expect(value.machine.submit(value.request)).rejects.toMatchObject({
      body: { code: 'branch_conflict' },
    });
    expect(writeCount(value, 'createPullRequest')).toBe(0);
  });
});
