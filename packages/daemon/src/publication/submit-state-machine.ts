import { z } from 'zod';

import type {
  PublicationJournalStore,
  PublicationLock,
  PublicationReceiptStore,
} from './durable-store.js';
import { validatePublicationJournal } from './durable-store.js';
import {
  GitHubAdapterError,
  provisionVerifiedFork,
  type GitHubPort,
  type PullRequestIdentity,
} from './github/index.js';
import type { SealedPreviewStore } from './preview-store.js';
import { validatePublicationReceipt } from './receipt.js';
import type { SubmitPreflight } from './submit-preflight.js';
import { parseCanonicalRepository } from './target.js';
import {
  PublicationError,
  type PublicationJournal,
  type PublicationReceipt,
  type SealedPublication,
} from './types.js';
import type {
  GitCommitIdentity,
  GitWorkspacePort,
  PreparedWorkspace,
} from './workspace/git.js';

const SubmitInput = z
  .object({
    publicationRef: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    targetRevision: z.number().int().nonnegative().safe(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmPublic: z.literal(true),
  })
  .strict();

export type ConfirmedSubmitInput = z.infer<typeof SubmitInput>;

export interface PublicationSubmitStateMachineOptions {
  preflight: SubmitPreflight;
  journals: PublicationJournalStore;
  receipts: PublicationReceiptStore;
  lock: PublicationLock;
  previews: SealedPreviewStore;
  workspace: GitWorkspacePort;
  github: GitHubPort;
  managedRoot: string;
  now?: () => Date;
  forkAttempts?: number;
  waitForFork?: (attempt: number) => Promise<void>;
  remoteUrl?: (repository: string) => string;
}

function stale(): never {
  throw new PublicationError({
    code: 'preview_stale',
    phase: 'preview',
    message: 'The publication preview is stale. Create a new preview.',
    retryable: false,
  });
}

function unavailable(): never {
  throw new PublicationError({
    code: 'workspace_unavailable',
    phase: 'workspace',
    message: 'Publication recovery storage is unavailable.',
    retryable: true,
  });
}

function branchConflict(): never {
  throw new PublicationError({
    code: 'branch_conflict',
    phase: 'push',
    message: 'The contribution branch already contains different content.',
    retryable: false,
  });
}

function pullRequestFailed(): never {
  throw new PublicationError({
    code: 'pr_create_failed',
    phase: 'pull_request',
    message: 'The pull request could not be created.',
    retryable: true,
  });
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultRemoteUrl(repository: string): string {
  const canonical = parseCanonicalRepository(repository);
  return `https://github.com/${canonical.slug}.git`;
}

function assertRequestBinding(
  input: ConfirmedSubmitInput,
  targetRevision: number,
  contentDigest: string,
): void {
  if (
    input.targetRevision !== targetRevision ||
    input.contentDigest !== contentDigest
  ) {
    stale();
  }
}

function assertSafeJournal(journal: PublicationJournal): SealedPublication {
  try {
    const validated = validatePublicationJournal(
      journal,
      journal.publicationRef,
    );
    if (!validated.seal) return unavailable();
    return validated.seal;
  } catch {
    return unavailable();
  }
}

export class PublicationSubmitStateMachine {
  private readonly now: () => Date;
  private readonly remoteUrl: (repository: string) => string;

  constructor(private readonly options: PublicationSubmitStateMachineOptions) {
    this.now = options.now ?? (() => new Date());
    this.remoteUrl = options.remoteUrl ?? defaultRemoteUrl;
  }

  async submit(input: unknown): Promise<PublicationReceipt> {
    const parsed = SubmitInput.safeParse(input);
    if (!parsed.success) return stale();
    return this.options.lock.run(() => this.run(parsed.data));
  }

  private async run(input: ConfirmedSubmitInput): Promise<PublicationReceipt> {
    const storedReceipt = await this.options.receipts.read(input.publicationRef);
    const receipt = storedReceipt
      ? validatePublicationReceipt(storedReceipt)
      : null;
    if (receipt) {
      assertRequestBinding(input, receipt.targetRevision, receipt.contentDigest);
      await this.finishJournalFromReceipt(receipt);
      return receipt;
    }

    let journal = await this.options.journals.read(input.publicationRef);
    if (journal) {
      assertRequestBinding(input, journal.targetRevision, journal.contentDigest);
      assertSafeJournal(journal);
      if (journal.phase === 'completed') {
        if (!journal.receipt) return unavailable();
        const restored = await this.options.receipts.write(
          validatePublicationReceipt(journal.receipt),
        );
        return restored;
      }
    } else {
      const preflight = await this.options.preflight.validate(input);
      if (preflight.kind === 'receipt') return preflight.receipt;
      journal = await this.writeInitialJournal(preflight.seal);
    }

    const seal = assertSafeJournal(journal);

    let workspace: PreparedWorkspace | undefined;
    let identity: GitCommitIdentity | undefined;

    if (journal.phase === 'validated') {
      workspace = await this.options.workspace.prepare({
        managedRoot: this.options.managedRoot,
        publicationRef: journal.publicationRef,
        repositoryId: journal.repositoryId,
        upstreamRemote: this.remoteUrl(journal.upstream),
        pushRemote: this.remoteUrl(journal.pushRepository),
        baseCommitSha: journal.baseCommitSha,
        branch: journal.branch,
      });
      await this.options.workspace.write(workspace, seal.bundle);
      identity = await this.options.workspace.commit(workspace, seal.bundle);
      journal = await this.transition(journal, {
        phase: 'committed',
        commitSha: identity.commitSha,
        treeSha: identity.treeSha,
      });
    }

    if (journal.phase === 'committed') {
      ({ workspace, identity } = await this.recoverCommittedWorkspace(journal));
      if (seal.target.forkProvision === 'on-submit') {
        const fork = await provisionVerifiedFork(
          this.options.github,
          seal.target,
          {
            attempts: this.options.forkAttempts,
            wait: this.options.waitForFork,
          },
        );
        if (
          fork.slug.toLowerCase() !== journal.pushRepository.toLowerCase()
        ) {
          return pullRequestFailed();
        }
      }
      journal = await this.transition(journal, { phase: 'fork_ready' });
    }

    if (journal.phase === 'fork_ready') {
      ({ workspace, identity } = await this.recoverCommittedWorkspace(journal));
      const pushed = await this.options.workspace.push(workspace, identity);
      if (pushed.state === 'conflict') return branchConflict();
      if (
        !/^[a-f0-9]{40,64}$/.test(pushed.commitSha) ||
        pushed.treeSha !== identity.treeSha
      ) {
        return unavailable();
      }
      journal = await this.transition(journal, {
        phase: 'pushed',
        commitSha: pushed.commitSha,
        treeSha: pushed.treeSha,
      });
    }

    if (journal.phase === 'pushed') {
      const prIdentity = this.pullRequestIdentity(journal);
      let pullRequest;
      try {
        pullRequest = await this.options.github.findPullRequest(prIdentity);
        if (!pullRequest) {
          pullRequest = await this.options.github.createPullRequest({
            ...prIdentity,
            title: seal.bundle.prTitle,
            body: seal.bundle.prBody,
          });
        }
      } catch (error) {
        if (error instanceof GitHubAdapterError) return pullRequestFailed();
        if (error instanceof PublicationError) throw error;
        return pullRequestFailed();
      }
      if (
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number < 1 ||
        pullRequest.url !==
          `https://github.com/${journal.upstream}/pull/${String(
            pullRequest.number,
          )}`
      ) {
        return pullRequestFailed();
      }
      journal = await this.transition(journal, {
        phase: 'pr_observed',
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
      });
    }

    if (journal.phase === 'pr_observed') {
      const completedReceipt = this.receiptFrom(journal);
      const persisted = await this.options.receipts.write(
        validatePublicationReceipt(completedReceipt),
      );
      journal = await this.transition(journal, {
        phase: 'completed',
        receipt: persisted,
      });
      this.options.previews.delete(journal.publicationRef);
      return persisted;
    }

    if (journal.phase === 'completed' && journal.receipt) {
      const restored = await this.options.receipts.write(
        validatePublicationReceipt(journal.receipt),
      );
      this.options.previews.delete(journal.publicationRef);
      return restored;
    }
    return unavailable();
  }

  private async writeInitialJournal(
    seal: SealedPublication,
  ): Promise<PublicationJournal> {
    return this.options.journals.write({
      schemaVersion: 1,
      publicationRef: seal.publicationRef,
      targetRevision: seal.target.revision,
      contentDigest: seal.bundle.contentDigest,
      phase: 'validated',
      upstream: seal.target.upstream,
      pushRepository: seal.target.pushRepository,
      mode: seal.target.route,
      baseBranch: seal.target.defaultBranch,
      baseCommitSha: seal.target.baseCommitSha,
      branch: seal.bundle.branch,
      repositoryId: seal.target.repositoryId,
      seal: structuredClone(seal),
      updatedAt: this.now().toISOString(),
    });
  }

  private async transition(
    journal: PublicationJournal,
    update: Partial<PublicationJournal> & {
      phase: PublicationJournal['phase'];
    },
  ): Promise<PublicationJournal> {
    return this.options.journals.write({
      ...journal,
      ...update,
      updatedAt: this.now().toISOString(),
    });
  }

  private async recoverCommittedWorkspace(
    journal: PublicationJournal,
  ): Promise<{
    workspace: PreparedWorkspace;
    identity: GitCommitIdentity;
  }> {
    if (!journal.commitSha || !journal.treeSha) return unavailable();
    const identity = {
      commitSha: journal.commitSha,
      treeSha: journal.treeSha,
    };
    const workspace = await this.options.workspace.recover({
      managedRoot: this.options.managedRoot,
      publicationRef: journal.publicationRef,
      repositoryId: journal.repositoryId,
      upstreamRemote: this.remoteUrl(journal.upstream),
      pushRemote: this.remoteUrl(journal.pushRepository),
      baseCommitSha: journal.baseCommitSha,
      branch: journal.branch,
      ...identity,
    });
    return { workspace, identity };
  }

  private pullRequestIdentity(
    journal: PublicationJournal,
  ): PullRequestIdentity {
    return {
      upstream: journal.upstream,
      upstreamRepositoryId: journal.repositoryId,
      pushRepository: journal.pushRepository,
      base: journal.baseBranch,
      headBranch: journal.branch,
    };
  }

  private receiptFrom(journal: PublicationJournal): PublicationReceipt {
    if (!journal.commitSha || !journal.prNumber || !journal.prUrl) {
      return unavailable();
    }
    return {
      publicationRef: journal.publicationRef,
      targetRevision: journal.targetRevision,
      upstream: journal.upstream,
      pushRepository: journal.pushRepository,
      mode: journal.mode,
      baseBranch: journal.baseBranch,
      baseCommitSha: journal.baseCommitSha,
      branch: journal.branch,
      commitSha: journal.commitSha,
      prNumber: journal.prNumber,
      prUrl: journal.prUrl,
      recordCount: journal.seal?.bundle.recordCount ?? 0,
      contentDigest: journal.contentDigest,
      submittedAt: this.now().toISOString(),
    };
  }

  private async finishJournalFromReceipt(
    receipt: PublicationReceipt,
  ): Promise<void> {
    const journal = await this.options.journals.read(receipt.publicationRef);
    if (!journal) return;
    assertSafeJournal(journal);
    if (journal.phase === 'pr_observed') {
      await this.transition(journal, { phase: 'completed', receipt });
      this.options.previews.delete(receipt.publicationRef);
    } else if (
      journal.phase === 'completed' &&
      journal.receipt &&
      !exactJson(journal.receipt, receipt)
    ) {
      unavailable();
    }
  }
}
