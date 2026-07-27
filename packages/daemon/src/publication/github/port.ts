export interface GitHubActor {
  login: string;
}

export type GitHubViewerPermission =
  | 'ADMIN'
  | 'MAINTAIN'
  | 'WRITE'
  | 'TRIAGE'
  | 'READ'
  | 'NONE';

export interface GitHubRepositorySnapshot {
  id: string;
  slug: string;
  url: string;
  visibility: 'public' | 'private';
  defaultBranch: string;
  defaultHeadSha: string;
  viewerPermission: GitHubViewerPermission;
}

export interface GitHubFork {
  id: string;
  slug: string;
  url: string;
  owner: string;
  sourceRepositoryId: string;
}

export interface GitHubManifestAtCommit {
  contents: string;
  contentHash: string;
}

export interface PullRequestIdentity {
  upstream: string;
  upstreamRepositoryId: string;
  pushRepository: string;
  base: string;
  headBranch: string;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
}

export interface CreatePullRequestInput extends PullRequestIdentity {
  title: string;
  body: string;
}

export interface GitHubPort {
  inspectActor(): Promise<GitHubActor>;
  inspectRepository(slug: string): Promise<GitHubRepositorySnapshot>;
  readDatasetManifest(input: {
    repository: string;
    commitSha: string;
  }): Promise<GitHubManifestAtCommit>;
  inspectFork(input: {
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork | null>;
  ensureFork(input: {
    upstream: string;
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork>;
  findPullRequest(input: PullRequestIdentity): Promise<GitHubPullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
}

export type GitHubAdapterErrorCode =
  | 'client_missing'
  | 'login_required'
  | 'not_found'
  | 'unavailable'
  | 'permission_denied'
  | 'invalid_response'
  | 'write_failed';

export class GitHubAdapterError extends Error {
  constructor(readonly code: GitHubAdapterErrorCode) {
    super('GitHub operation failed.');
    this.name = 'GitHubAdapterError';
  }
}
