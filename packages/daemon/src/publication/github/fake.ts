import {
  GitHubAdapterError,
  type CreatePullRequestInput,
  type GitHubActor,
  type GitHubFork,
  type GitHubManifestAtCommit,
  type GitHubPort,
  type GitHubPullRequest,
  type GitHubRepositorySnapshot,
  type PullRequestIdentity,
} from './port.js';

export interface RecordingGitHubState {
  actor: GitHubActor | GitHubAdapterError;
  repository: GitHubRepositorySnapshot | GitHubAdapterError;
  manifest: GitHubManifestAtCommit | GitHubAdapterError;
  fork: GitHubFork | null | GitHubAdapterError;
  ensuredFork: GitHubFork | GitHubAdapterError;
  pullRequest: GitHubPullRequest | null | GitHubAdapterError;
  createdPullRequest: GitHubPullRequest | GitHubAdapterError;
}

export interface GitHubRecording {
  operation: keyof GitHubPort;
  input?: unknown;
}

function valueOrThrow<T>(value: T | GitHubAdapterError): T {
  if (value instanceof GitHubAdapterError) throw value;
  return value;
}

export class RecordingGitHubPort implements GitHubPort {
  readonly calls: GitHubRecording[] = [];
  readonly state: RecordingGitHubState;

  constructor(state: Partial<RecordingGitHubState> = {}) {
    this.state = {
      actor: { login: 'actor' },
      repository: {
        id: 'R_upstream',
        slug: 'owner/repo',
        url: 'https://github.com/owner/repo',
        visibility: 'public',
        defaultBranch: 'main',
        defaultHeadSha: 'a'.repeat(40),
        viewerPermission: 'WRITE',
      },
      manifest: {
        contents: JSON.stringify({
          kind: 'mosga-community-data',
          contractVersion: 1,
          acceptedSchemaVersions: ['0.1.0'],
          license: 'CC-BY-4.0',
        }),
        contentHash: 'b'.repeat(64),
      },
      fork: null,
      ensuredFork: {
        id: 'R_fork',
        slug: 'actor/repo',
        url: 'https://github.com/actor/repo',
        owner: 'actor',
        sourceRepositoryId: 'R_upstream',
      },
      pullRequest: null,
      createdPullRequest: {
        number: 1,
        url: 'https://github.com/owner/repo/pull/1',
      },
      ...state,
    };
  }

  async inspectActor(): Promise<GitHubActor> {
    this.calls.push({ operation: 'inspectActor' });
    return structuredClone(valueOrThrow(this.state.actor));
  }

  async inspectRepository(slug: string): Promise<GitHubRepositorySnapshot> {
    this.calls.push({ operation: 'inspectRepository', input: slug });
    return structuredClone(valueOrThrow(this.state.repository));
  }

  async readDatasetManifest(input: {
    repository: string;
    commitSha: string;
  }): Promise<GitHubManifestAtCommit> {
    this.calls.push({ operation: 'readDatasetManifest', input });
    return structuredClone(valueOrThrow(this.state.manifest));
  }

  async inspectFork(input: {
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork | null> {
    this.calls.push({ operation: 'inspectFork', input });
    const value = valueOrThrow(this.state.fork);
    return value ? structuredClone(value) : null;
  }

  async ensureFork(input: {
    upstream: string;
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork> {
    this.calls.push({ operation: 'ensureFork', input });
    return structuredClone(valueOrThrow(this.state.ensuredFork));
  }

  async findPullRequest(input: PullRequestIdentity): Promise<GitHubPullRequest | null> {
    this.calls.push({ operation: 'findPullRequest', input });
    const value = valueOrThrow(this.state.pullRequest);
    return value ? structuredClone(value) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    this.calls.push({ operation: 'createPullRequest', input });
    return structuredClone(valueOrThrow(this.state.createdPullRequest));
  }
}
