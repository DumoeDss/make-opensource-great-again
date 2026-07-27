import {
  parseDatasetManifest,
} from '../target.js';
import {
  PublicationError,
  type StoredPublicationTarget,
  type TargetSnapshot,
  type TargetSummary,
} from '../types.js';
import {
  GitHubAdapterError,
  type GitHubFork,
  type GitHubPort,
  type GitHubRepositorySnapshot,
} from './port.js';

const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

export interface ResolvedGitHubTarget {
  summary: TargetSummary;
  snapshot: TargetSnapshot;
}

function mapAdapterError(error: GitHubAdapterError, phase: 'target' | 'preview'): never {
  const byCode = {
    client_missing: {
      code: 'github_client_missing' as const,
      message: 'GitHub CLI is not available.',
      retryable: false,
    },
    login_required: {
      code: 'github_login_required' as const,
      message: 'Sign in with gh auth login before publishing.',
      retryable: false,
    },
    not_found: {
      code: 'target_not_found' as const,
      message: 'The configured GitHub repository was not found.',
      retryable: false,
    },
    unavailable: {
      code: 'github_unavailable' as const,
      message: 'GitHub is temporarily unavailable.',
      retryable: true,
    },
    permission_denied: {
      code: 'permission_denied' as const,
      message: 'The GitHub account cannot publish to this repository.',
      retryable: false,
    },
    invalid_response: {
      code: 'github_unavailable' as const,
      message: 'GitHub returned an unsupported response.',
      retryable: true,
    },
    write_failed: {
      code: 'fork_failed' as const,
      message: 'The GitHub fork could not be prepared.',
      retryable: true,
    },
  }[error.code];
  throw new PublicationError({ phase, ...byCode });
}

export function summaryOf(
  repository: GitHubRepositorySnapshot,
  manifest: ReturnType<typeof parseDatasetManifest>,
  manifestHash: string,
): TargetSummary {
  return {
    repositoryId: repository.id,
    slug: repository.slug,
    url: repository.url,
    visibility: 'public',
    defaultBranch: repository.defaultBranch,
    baseCommitSha: repository.defaultHeadSha,
    manifest: {
      ...manifest,
      acceptedSchemaVersions: [...manifest.acceptedSchemaVersions],
      contentHash: manifestHash,
    },
  };
}

export interface CompatibleTargetInspection {
  repository: GitHubRepositorySnapshot;
  summary: TargetSummary;
  manifest: ReturnType<typeof parseDatasetManifest>;
  manifestContents: string;
  manifestContentHash: string;
}

export async function inspectCompatibleTarget(
  target: StoredPublicationTarget,
  github: GitHubPort,
): Promise<CompatibleTargetInspection> {
  if (!target.upstream) {
    throw new PublicationError({
      code: 'target_not_configured',
      phase: 'target',
      message: 'Configure a GitHub publication target first.',
      retryable: false,
    });
  }
  const slug = `${target.upstream.owner}/${target.upstream.repo}`;
  try {
    const repository = await github.inspectRepository(slug);
    if (
      repository.slug.toLowerCase() !== slug.toLowerCase() ||
      repository.visibility !== 'public' ||
      repository.defaultBranch.length === 0
    ) {
      throw new PublicationError({
        code: 'target_incompatible',
        phase: 'target',
        message: 'The target repository is not a compatible public dataset.',
        retryable: false,
      });
    }
    const source = await github.readDatasetManifest({
      repository: repository.slug,
      commitSha: repository.defaultHeadSha,
    });
    const manifest = parseDatasetManifest(source.contents);
    return {
      repository,
      summary: summaryOf(repository, manifest, source.contentHash),
      manifest,
      manifestContents: source.contents,
      manifestContentHash: source.contentHash,
    };
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    if (error instanceof GitHubAdapterError) return mapAdapterError(error, 'target');
    throw new PublicationError({
      code: 'github_unavailable',
      phase: 'target',
      message: 'GitHub is temporarily unavailable.',
      retryable: true,
    });
  }
}

export async function resolveGitHubTarget(
  target: StoredPublicationTarget,
  github: GitHubPort,
): Promise<ResolvedGitHubTarget> {
  if (!target.upstream) {
    throw new PublicationError({
      code: 'target_not_configured',
      phase: 'target',
      message: 'Configure a GitHub publication target first.',
      retryable: false,
    });
  }
  try {
    const compatible = await inspectCompatibleTarget(target, github);
    const { repository, summary, manifest } = compatible;
    const actor = await github.inspectActor();

    let route: TargetSnapshot['route'];
    let pushRepository: string;
    let forkProvision: TargetSnapshot['forkProvision'];
    if (WRITE_PERMISSIONS.has(repository.viewerPermission)) {
      route = 'direct';
      pushRepository = repository.slug;
      forkProvision = 'none';
    } else {
      const expectedSlug = `${actor.login}/${target.upstream.repo}`;
      const fork = await github.inspectFork({
        upstreamRepositoryId: repository.id,
        actor: actor.login,
        expectedSlug,
      });
      if (fork) {
        assertVerifiedFork(fork, repository.id, actor.login, expectedSlug);
        route = 'fork';
        pushRepository = fork.slug;
        forkProvision = 'existing';
      } else {
        // GitHub does not expose one reliable read-only "this actor can fork
        // this public repository" bit. Keep preview read-only and let confirmed
        // submit perform the semantic fork attempt with stable error mapping.
        route = 'fork';
        pushRepository = expectedSlug;
        forkProvision = 'on-submit';
      }
    }
    return {
      summary,
      snapshot: {
        revision: target.revision,
        repositoryId: repository.id,
        upstream: repository.slug,
        upstreamUrl: repository.url,
        actor: actor.login,
        route,
        pushRepository,
        forkProvision,
        defaultBranch: repository.defaultBranch,
        baseCommitSha: repository.defaultHeadSha,
        manifestContentHash: compatible.manifestContentHash,
        manifestContents: compatible.manifestContents,
        manifest,
      },
    };
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    if (error instanceof GitHubAdapterError) return mapAdapterError(error, 'target');
    throw new PublicationError({
      code: 'github_unavailable',
      phase: 'target',
      message: 'GitHub is temporarily unavailable.',
      retryable: true,
    });
  }
}

export function assertVerifiedFork(
  fork: GitHubFork,
  upstreamRepositoryId: string,
  actor: string,
  expectedSlug?: string,
): void {
  if (
    fork.sourceRepositoryId !== upstreamRepositoryId ||
    fork.owner.toLowerCase() !== actor.toLowerCase() ||
    (expectedSlug !== undefined &&
      fork.slug.toLowerCase() !== expectedSlug.toLowerCase())
  ) {
    throw new PublicationError({
      code: 'permission_denied',
      phase: 'target',
      message: 'An unrelated repository cannot be used as the publication fork.',
      retryable: false,
    });
  }
}

export interface ForkProvisionOptions {
  attempts?: number;
  wait?: (attempt: number) => Promise<void>;
}

async function waitForForkPropagation(attempt: number): Promise<void> {
  const delayMs = Math.min(250 * (attempt + 1), 1_000);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function provisionVerifiedFork(
  github: GitHubPort,
  snapshot: TargetSnapshot,
  options: ForkProvisionOptions = {},
): Promise<GitHubFork> {
  if (snapshot.route !== 'fork') {
    throw new PublicationError({
      code: 'fork_failed',
      phase: 'push',
      message: 'A fork is not part of this publication route.',
      retryable: false,
    });
  }
  const input = {
    upstream: snapshot.upstream,
    upstreamRepositoryId: snapshot.repositoryId,
    actor: snapshot.actor,
    expectedSlug: snapshot.pushRepository,
  };
  try {
    let fork = await github.inspectFork(input);
    if (fork) {
      assertVerifiedFork(
        fork,
        snapshot.repositoryId,
        snapshot.actor,
        snapshot.pushRepository,
      );
      return fork;
    }
    const created = await github.ensureFork(input);
    assertVerifiedFork(
      created,
      snapshot.repositoryId,
      snapshot.actor,
      snapshot.pushRepository,
    );
    const attempts = Math.max(1, options.attempts ?? 5);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      fork = await github.inspectFork(input);
      if (fork) {
        assertVerifiedFork(
          fork,
          snapshot.repositoryId,
          snapshot.actor,
          snapshot.pushRepository,
        );
        return fork;
      }
      if (attempt + 1 < attempts) {
        await (options.wait ?? waitForForkPropagation)(attempt);
      }
    }
    throw new PublicationError({
      code: 'fork_failed',
      phase: 'push',
      message: 'The GitHub fork is not ready yet.',
      retryable: true,
    });
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    if (error instanceof GitHubAdapterError) {
      throw new PublicationError({
        code: 'fork_failed',
        phase: 'push',
        message: 'The GitHub fork could not be prepared.',
        retryable: true,
      });
    }
    throw error;
  }
}
