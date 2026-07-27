import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  GitCommitIdentity,
  GitHubPublication,
  PrepareWorkspaceInput,
  PreparedWorkspace,
  PublicationReceipt,
  PushResult,
  RecoverWorkspaceInput,
} from '../publication/index.js';
import type { GitWorkspacePort } from '../publication/index.js';
import {
  InMemoryPublicationJournalStore,
  InMemoryPublicationLock,
  InMemoryPublicationReceiptStore,
  InMemoryPublicationTargetStore,
  InMemorySealedPreviewStore,
  RecordingGitHubPort,
} from '../publication/index.js';
import {
  FAKE_AWS_KEY,
  makeTempDir,
  plainTurn,
  rm,
  withServer,
  writeSession,
} from './_helpers.js';

const NOW = '2026-07-27T00:00:00.000Z';

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

class LocalRecordingWorkspace implements GitWorkspacePort {
  readonly calls: string[] = [];
  private readonly identity = {
    commitSha: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
  };

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    this.calls.push('prepare');
    return this.value(input);
  }

  async recover(input: RecoverWorkspaceInput): Promise<PreparedWorkspace> {
    this.calls.push('recover');
    return this.value(input);
  }

  async write(): Promise<void> {
    this.calls.push('write');
  }

  async commit(): Promise<GitCommitIdentity> {
    this.calls.push('commit');
    return this.identity;
  }

  async push(): Promise<PushResult> {
    this.calls.push('push');
    return { state: 'pushed', ...this.identity };
  }

  private value(input: PrepareWorkspaceInput): PreparedWorkspace {
    return {
      paths: {
        root: input.managedRoot,
        cache: 'private',
        worktree: 'private',
        marker: 'private',
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

describe('canonical publication HTTP routes', () => {
  let home: string;
  let cwd: string;
  let publicationRoot: string;

  beforeEach(() => {
    home = makeTempDir('mosga-publish-home-');
    cwd = makeTempDir('mosga-publish-cwd-');
    publicationRoot = makeTempDir('mosga-publish-managed-');
    writeSession(home, 'projX', 'sess-x', cwd, [
      plainTurn('message-1', 'clean contribution'),
    ]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
    rm(publicationRoot);
  });

  it('supports configure/status/clear and strict request schemas', async () => {
    const calls: string[] = [];
    const receipt: PublicationReceipt = {
      publicationRef: 'publication_1',
      targetRevision: 1,
      upstream: 'owner/repo',
      pushRepository: 'owner/repo',
      mode: 'direct',
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      branch: 'contrib/test/abcdef12',
      commitSha: 'c'.repeat(40),
      prNumber: 1,
      prUrl: 'https://github.com/owner/repo/pull/1',
      recordCount: 1,
      contentDigest: 'e'.repeat(64),
      submittedAt: NOW,
    };
    const publication: GitHubPublication = {
      async inspect() {
        calls.push('inspect');
        return { state: 'unconfigured', revision: 0 };
      },
      async configure(input) {
        calls.push(`configure:${input.repository}`);
        return { state: 'unconfigured', revision: 1 };
      },
      async clear() {
        calls.push('clear');
        return { state: 'unconfigured', revision: 2 };
      },
      async preview(input) {
        calls.push(`preview:${input.reviewIds.join(',')}`);
        throw new Error('not reached by this contract test');
      },
      async submit() {
        calls.push('submit');
        return receipt;
      },
    };
    await withServer({ homeDir: home, publication }, async (base) => {
      expect((await fetch(`${base}/api/publish`)).status).toBe(200);
      const configured = await fetch(
        `${base}/api/publish/target`,
        json('PUT', { repository: 'owner/repo' }),
      );
      expect(configured.status).toBe(200);
      const extraTarget = await fetch(
        `${base}/api/publish/target`,
        json('PUT', { repository: 'owner/repo', workspace: 'C:\\private' }),
      );
      expect(extraTarget.status).toBe(400);
      const invalidSubmit = await fetch(
        `${base}/api/publish/submit`,
        json('POST', {
          publicationRef: 'publication_1',
          targetRevision: 1,
          contentDigest: 'e'.repeat(64),
          confirmPublic: true,
          token: 'fake-token',
        }),
      );
      expect(invalidSubmit.status).toBe(400);
      expect(
        (
          await fetch(`${base}/api/publish/target`, json('DELETE'))
        ).status,
      ).toBe(200);
    });
    expect(calls).toEqual(['inspect', 'configure:owner/repo', 'clear']);
  });

  it('runs one real review through preview and confirmed submit with fake GitHub/workspace ports', async () => {
    const targets = new InMemoryPublicationTargetStore();
    await targets.configure({ owner: 'owner', repo: 'repo' });
    const github = new RecordingGitHubPort();
    const workspace = new LocalRecordingWorkspace();
    await withServer(
      {
        homeDir: home,
        now: NOW,
        publicationRoot,
        publicationTargetStore: targets,
        publicationPreviews: new InMemorySealedPreviewStore({
          id: () => 'publication_http',
          now: () => new Date(NOW),
        }),
        publicationJournals: new InMemoryPublicationJournalStore(),
        publicationReceipts: new InMemoryPublicationReceiptStore(),
        publicationLock: new InMemoryPublicationLock(),
        publicationGitHub: github,
        publicationWorkspace: workspace,
      },
      async (base) => {
        const reviewResponse = await fetch(
          `${base}/api/reviews`,
          json('POST', {
            sourceId: 'claude-code',
            projectKey: 'projX',
            sessionId: 'sess-x',
          }),
        );
        expect(reviewResponse.status).toBe(201);
        const reviewId = ((await reviewResponse.json()) as { reviewId: string })
          .reviewId;

        const previewResponse = await fetch(
          `${base}/api/publish/preview`,
          json('POST', { reviewIds: [reviewId] }),
        );
        expect(previewResponse.status).toBe(201);
        const preview = (await previewResponse.json()) as {
          publicationRef: string;
          target: { revision: number };
          contribution: { contentDigest: string; recordCount: number };
        };
        expect(preview.contribution.recordCount).toBe(1);

        const submitResponse = await fetch(
          `${base}/api/publish/submit`,
          json('POST', {
            publicationRef: preview.publicationRef,
            targetRevision: preview.target.revision,
            contentDigest: preview.contribution.contentDigest,
            confirmPublic: true,
          }),
        );
        expect(submitResponse.status).toBe(200);
        const body = await submitResponse.text();
        const receipt = JSON.parse(body) as PublicationReceipt;
        expect(receipt).toMatchObject({
          upstream: 'owner/repo',
          pushRepository: 'owner/repo',
          prNumber: 1,
          recordCount: 1,
        });
        expect(body).not.toContain('contents');
        expect(body).not.toContain(publicationRoot);
      },
    );
    expect(workspace.calls).toEqual([
      'prepare',
      'write',
      'commit',
      'recover',
      'recover',
      'push',
    ]);
    expect(
      github.calls.filter((call) => call.operation === 'createPullRequest'),
    ).toHaveLength(1);
  });

  it('maps submit recompilation refusal to a sanitized HTTP contract', async () => {
    const targets = new InMemoryPublicationTargetStore();
    await targets.configure({ owner: 'owner', repo: 'repo' });
    const github = new RecordingGitHubPort();
    const workspace = new LocalRecordingWorkspace();
    await withServer(
      {
        homeDir: home,
        now: NOW,
        publicationRoot,
        publicationTargetStore: targets,
        publicationPreviews: new InMemorySealedPreviewStore({
          id: () => 'publication_refusal',
          now: () => new Date(NOW),
        }),
        publicationJournals: new InMemoryPublicationJournalStore(),
        publicationReceipts: new InMemoryPublicationReceiptStore(),
        publicationLock: new InMemoryPublicationLock(),
        publicationGitHub: github,
        publicationWorkspace: workspace,
      },
      async (base, daemon) => {
        const reviewResponse = await fetch(
          `${base}/api/reviews`,
          json('POST', {
            sourceId: 'claude-code',
            projectKey: 'projX',
            sessionId: 'sess-x',
          }),
        );
        const reviewId = (
          (await reviewResponse.json()) as { reviewId: string }
        ).reviewId;
        const previewResponse = await fetch(
          `${base}/api/publish/preview`,
          json('POST', { reviewIds: [reviewId] }),
        );
        const preview = (await previewResponse.json()) as {
          publicationRef: string;
          target: { revision: number };
          contribution: { contentDigest: string };
        };

        const state = daemon.app.store.get(reviewId);
        if (!state) throw new Error('review fixture missing');
        state.session.messages[0].content =
          `changed after preview ${FAKE_AWS_KEY}`;

        const response = await fetch(
          `${base}/api/publish/submit`,
          json('POST', {
            publicationRef: preview.publicationRef,
            targetRevision: preview.target.revision,
            contentDigest: preview.contribution.contentDigest,
            confirmPublic: true,
          }),
        );
        expect(response.status).toBe(422);
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({
          code: 'precheck_refused',
          phase: 'preview',
          refusals: [
            {
              reviewId,
              sessionId: 'sess-x',
              blockingByRule: expect.any(Object),
            },
          ],
        });
        for (const forbidden of [
          FAKE_AWS_KEY,
          'changed after preview',
          publicationRoot,
          'data/',
          'stderr',
          'git push',
        ]) {
          expect(body).not.toContain(forbidden);
        }
      },
    );
    expect(workspace.calls).toEqual([]);
    expect(
      github.calls.filter((call) =>
        ['ensureFork', 'createPullRequest'].includes(call.operation),
      ),
    ).toEqual([]);
  });
});
