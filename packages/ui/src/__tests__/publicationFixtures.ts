import type {
  PublicationErrorBody,
  PublicationPreview,
  PublicationReceipt,
  PublicationStatus,
  PublicationTargetSummary,
} from '../api/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

export function publicationTarget(
  over: Partial<PublicationTargetSummary> = {},
): PublicationTargetSummary {
  return {
    repositoryId: 'R_upstream',
    slug: 'community/dataset',
    url: 'https://github.com/community/dataset',
    visibility: 'public',
    defaultBranch: 'main',
    baseCommitSha: SHA_A,
    manifest: {
      kind: 'mosga-community-data',
      contractVersion: 1,
      acceptedSchemaVersions: ['0.1.0'],
      license: 'CC0-1.0',
      contentHash: HASH_A,
    },
    ...over,
  };
}

export function directStatus(): Extract<PublicationStatus, { state: 'ready' }> {
  return {
    state: 'ready',
    revision: 7,
    target: publicationTarget(),
    actor: 'contributor',
    route: 'direct',
    pushRepository: 'community/dataset',
    willCreateFork: false,
  };
}

export function existingForkStatus(): Extract<PublicationStatus, { state: 'ready' }> {
  return {
    ...directStatus(),
    route: 'fork',
    pushRepository: 'contributor/dataset',
  };
}

export function forkConfirmationStatus(): Extract<
  PublicationStatus,
  { state: 'fork_confirmation_required' }
> {
  return {
    state: 'fork_confirmation_required',
    revision: 7,
    target: publicationTarget(),
    actor: 'contributor',
    pushRepository: 'contributor/dataset',
  };
}

export function loginRequiredStatus(): Extract<PublicationStatus, { state: 'login_required' }> {
  return { state: 'login_required', revision: 7, target: publicationTarget() };
}

export function unconfiguredStatus(
  revision = 0,
): Extract<PublicationStatus, { state: 'unconfigured' }> {
  return { state: 'unconfigured', revision };
}

export function blockedStatus(
  withTarget = true,
): Extract<PublicationStatus, { state: 'blocked' }> {
  return {
    state: 'blocked',
    revision: 7,
    ...(withTarget ? { target: publicationTarget() } : {}),
    issues: [
      {
        code: 'target_incompatible',
        message: 'The repository contract is not compatible.',
        recovery: 'Choose a compatible public repository.',
        retryable: false,
      },
    ],
  };
}

export function publicationPreview(
  over: Partial<PublicationPreview> = {},
): PublicationPreview {
  const base: PublicationPreview = {
    publicationRef: 'publication_fixture',
    expiresAt: '2099-07-27T00:15:00.000Z',
    target: {
      repositoryId: 'R_upstream',
      revision: 7,
      upstream: 'community/dataset',
      pushRepository: 'community/dataset',
      route: 'direct',
      forkProvision: 'none',
      baseBranch: 'main',
      baseCommitSha: SHA_A,
      willCreateFork: false,
    },
    contribution: {
      contractVersion: 1,
      contentDigest: HASH_A,
      branch: 'contrib/fixture/abcdef12',
      commitMessage: 'Add sanitized sessions',
      prTitle: 'Add sanitized sessions',
      prBody: 'Adds one reviewed and sanitized session.',
      recordCount: 1,
      totalBytes: 42,
      files: [
        {
          kind: 'record',
          path: 'records/fixture.jsonl',
          bytes: 28,
          contentHash: HASH_A,
        },
        {
          kind: 'provenance',
          path: 'records/fixture.provenance.json',
          bytes: 14,
          contentHash: HASH_B,
        },
      ],
      engine: {
        sanitizerPackageVersion: '0.1.0',
        rulesetVersion: 'gitleaks@test+mosga-l3@0.1.0+custom@none',
        gitleaksVersion: '8.24.3',
      },
    },
  };
  return {
    ...base,
    ...over,
    target: { ...base.target, ...over.target },
    contribution: { ...base.contribution, ...over.contribution },
  };
}

export function existingForkPreview(): PublicationPreview {
  return publicationPreview({
    target: {
      ...publicationPreview().target,
      route: 'fork',
      pushRepository: 'contributor/dataset',
      forkProvision: 'existing',
    },
  });
}

export function onSubmitForkPreview(): PublicationPreview {
  return publicationPreview({
    target: {
      ...publicationPreview().target,
      route: 'fork',
      pushRepository: 'contributor/dataset',
      forkProvision: 'on-submit',
      willCreateFork: true,
    },
  });
}

export function publicationReceipt(
  over: Partial<PublicationReceipt> = {},
): PublicationReceipt {
  return {
    publicationRef: 'publication_fixture',
    targetRevision: 7,
    upstream: 'community/dataset',
    pushRepository: 'community/dataset',
    mode: 'direct',
    baseBranch: 'main',
    baseCommitSha: SHA_A,
    branch: 'contrib/fixture/abcdef12',
    commitSha: SHA_B,
    prNumber: 42,
    prUrl: 'https://github.com/community/dataset/pull/42',
    recordCount: 1,
    contentDigest: HASH_A,
    submittedAt: '2026-07-27T00:10:00.000Z',
    ...over,
  };
}

export function publicationError(
  over: Partial<PublicationErrorBody> = {},
): PublicationErrorBody {
  return {
    code: 'github_unavailable',
    phase: 'pull_request',
    message: 'GitHub is temporarily unavailable.',
    retryable: true,
    recovery: 'Retry this same publication.',
    ...over,
  };
}
