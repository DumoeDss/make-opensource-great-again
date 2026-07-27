import type {
  CompiledRuleset,
} from '@mosga/sanitizer';
import type {
  ContributionBundle,
  ContributionBundleOptions,
} from '@mosga/publisher';

export interface CanonicalRepository {
  owner: string;
  repo: string;
  slug: string;
}

export interface StoredPublicationTarget {
  schemaVersion: 1;
  revision: number;
  upstream: Pick<CanonicalRepository, 'owner' | 'repo'> | null;
}

export interface DatasetManifest {
  kind: 'mosga-community-data';
  contractVersion: 1;
  acceptedSchemaVersions: string[];
  license: string;
}

export interface DatasetManifestSource {
  contents: string;
  contentHash: string;
  manifest: DatasetManifest;
}

export interface TargetSummary {
  repositoryId: string;
  slug: string;
  url: string;
  visibility: 'public';
  defaultBranch: string;
  baseCommitSha: string;
  manifest: {
    kind: DatasetManifest['kind'];
    contractVersion: DatasetManifest['contractVersion'];
    acceptedSchemaVersions: string[];
    license: string;
    contentHash: string;
  };
}

export type PublicationIssueCode =
  | 'target_not_found'
  | 'target_incompatible'
  | 'target_store_unavailable'
  | 'github_client_missing'
  | 'github_unavailable'
  | 'permission_denied'
  | 'fork_failed';

export interface PublicationIssue {
  code: PublicationIssueCode;
  message: string;
  recovery?: string;
  retryable: boolean;
}

export type PublicationStatus =
  | { state: 'unconfigured'; revision: number }
  | {
      state: 'login_required';
      revision: number;
      target: TargetSummary;
    }
  | {
      state: 'fork_confirmation_required';
      revision: number;
      target: TargetSummary;
      actor: string;
      pushRepository: string;
    }
  | {
      state: 'ready';
      revision: number;
      target: TargetSummary;
      actor: string;
      route: 'direct' | 'fork';
      pushRepository: string;
      willCreateFork: false;
    }
  | {
      state: 'blocked';
      revision: number;
      target?: TargetSummary;
      issues: PublicationIssue[];
    };

export interface TargetSnapshot {
  revision: number;
  repositoryId: string;
  upstream: string;
  upstreamUrl: string;
  actor: string;
  route: 'direct' | 'fork';
  pushRepository: string;
  forkProvision: 'none' | 'existing' | 'on-submit';
  defaultBranch: string;
  baseCommitSha: string;
  manifestContentHash: string;
  manifestContents: string;
  manifest: DatasetManifest;
}

export interface PublicationFileSummary {
  kind: 'record' | 'provenance';
  path: string;
  bytes: number;
  contentHash: string;
}

export interface PublicationPreview {
  publicationRef: string;
  expiresAt: string;
  target: {
    repositoryId: string;
    revision: number;
    upstream: string;
    pushRepository: string;
    route: 'direct' | 'fork';
    forkProvision: 'none' | 'existing' | 'on-submit';
    baseBranch: string;
    baseCommitSha: string;
    willCreateFork: boolean;
  };
  contribution: {
    contractVersion: 1;
    contentDigest: string;
    branch: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    recordCount: number;
    totalBytes: number;
    files: PublicationFileSummary[];
    engine: ContributionBundle['engine'];
  };
}

/**
 * Private server-only preview. Exact contents, rules, and compiler options
 * deliberately never appear in any public projection.
 */
export interface SealedPublication {
  publicationRef: string;
  createdAt: string;
  expiresAt: string;
  reviewIds: string[];
  reviewSessionIds: Record<string, string>;
  target: TargetSnapshot;
  bundle: ContributionBundle;
  compilerOptions: ContributionBundleOptions;
  ruleset: CompiledRuleset;
}

export interface PublicationReceipt {
  publicationRef: string;
  targetRevision: number;
  upstream: string;
  pushRepository: string;
  mode: 'direct' | 'fork';
  baseBranch: string;
  baseCommitSha: string;
  branch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  recordCount: number;
  contentDigest: string;
  submittedAt: string;
}

export const PUBLICATION_JOURNAL_PHASES = [
  'validated',
  'committed',
  'fork_ready',
  'pushed',
  'pr_observed',
  'completed',
] as const;
export type PublicationJournalPhase = (typeof PUBLICATION_JOURNAL_PHASES)[number];

export interface PublicationJournal {
  schemaVersion: 1;
  publicationRef: string;
  targetRevision: number;
  contentDigest: string;
  phase: PublicationJournalPhase;
  upstream: string;
  pushRepository: string;
  mode: 'direct' | 'fork';
  baseBranch: string;
  baseCommitSha: string;
  branch: string;
  repositoryId: string;
  commitSha?: string;
  treeSha?: string;
  prNumber?: number;
  prUrl?: string;
  receipt?: PublicationReceipt;
  /**
   * Private durable continuation state written only after confirmed submit
   * passes every pre-write gate. It is never projected through HTTP.
   */
  seal?: SealedPublication;
  updatedAt: string;
}

export type PublicationErrorCode =
  | 'invalid_target'
  | 'target_not_configured'
  | 'target_not_found'
  | 'target_incompatible'
  | 'target_changed'
  | 'target_store_unavailable'
  | 'github_client_missing'
  | 'github_login_required'
  | 'github_unavailable'
  | 'permission_denied'
  | 'fork_confirmation_required'
  | 'fork_failed'
  | 'review_not_found'
  | 'GATE_LOCKED'
  | 'precheck_refused'
  | 'preview_not_found'
  | 'preview_expired'
  | 'preview_stale'
  | 'publish_in_flight'
  | 'workspace_unavailable'
  | 'workspace_corrupt'
  | 'branch_conflict'
  | 'push_rejected'
  | 'pr_create_failed';

export type PublicationErrorPhase =
  | 'target'
  | 'preview'
  | 'workspace'
  | 'push'
  | 'pull_request';

export interface PublicationErrorBody {
  code: PublicationErrorCode;
  phase: PublicationErrorPhase;
  message: string;
  retryable: boolean;
  recovery?: string;
  reviewId?: string;
  gate?: unknown;
  refusals?: Array<{
    reviewId: string;
    sessionId: string;
    blockingByRule: Record<string, number>;
  }>;
}

export class PublicationError extends Error {
  readonly body: PublicationErrorBody;

  constructor(body: PublicationErrorBody) {
    super(body.message);
    this.name = 'PublicationError';
    this.body = body;
  }
}

export interface GitHubPublication {
  inspect(): Promise<PublicationStatus>;
  configure(input: { repository: string }): Promise<PublicationStatus>;
  clear(): Promise<PublicationStatus>;
  preview(input: { reviewIds: string[] }): Promise<PublicationPreview>;
  submit(input: {
    publicationRef: string;
    targetRevision: number;
    contentDigest: string;
    confirmPublic: true;
  }): Promise<PublicationReceipt>;
}
