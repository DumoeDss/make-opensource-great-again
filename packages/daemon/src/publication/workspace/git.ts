import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ContributionBundle } from '@mosga/publisher';

import type { GitCredentialPort } from '../github/auth.js';
import { PublicationError } from '../types.js';
import {
  assertOwnedCache,
  assertOwnedManagedWorkspace,
  deriveManagedWorkspacePaths,
  prepareManagedWorkspaceLayout,
  writeCacheMarker,
  writeWorktreeMarker,
  type CacheMarker,
  type ManagedWorkspacePaths,
  type ReparseProbe,
  type WorktreeMarker,
} from './layout.js';
import type { ProcessResult, ProcessRunner } from './process.js';
import {
  verifyExactBundleFiles,
  writeExactBundleFiles,
} from './writer.js';

export interface PreparedWorkspace {
  paths: ManagedWorkspacePaths;
  marker: WorktreeMarker;
  baseCommitSha: string;
  branch: string;
}

export interface GitCommitIdentity {
  commitSha: string;
  treeSha: string;
}

export type PushResult =
  | { state: 'pushed' | 'adopted'; commitSha: string; treeSha: string }
  | { state: 'conflict' };

export interface PrepareWorkspaceInput {
  managedRoot: string;
  publicationRef: string;
  repositoryId: string;
  upstreamRemote: string;
  pushRemote: string;
  baseCommitSha: string;
  branch: string;
}

export interface RecoverWorkspaceInput extends PrepareWorkspaceInput {
  commitSha: string;
  treeSha: string;
}

export interface GitWorkspacePort {
  prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace>;
  recover(input: RecoverWorkspaceInput): Promise<PreparedWorkspace>;
  write(workspace: PreparedWorkspace, bundle: ContributionBundle): Promise<void>;
  commit(
    workspace: PreparedWorkspace,
    bundle: ContributionBundle,
  ): Promise<GitCommitIdentity>;
  push(
    workspace: PreparedWorkspace,
    identity: GitCommitIdentity,
  ): Promise<PushResult>;
}

export interface ManagedGitWorkspaceOptions {
  reparseProbe?: ReparseProbe;
}

function unavailable(
  code: 'workspace_unavailable' | 'workspace_corrupt' | 'push_rejected',
): never {
  throw new PublicationError({
    code,
    phase: code === 'push_rejected' ? 'push' : 'workspace',
    message:
      code === 'push_rejected'
        ? 'The contribution branch could not be pushed.'
        : 'The managed publication workspace is unavailable.',
    retryable: code !== 'workspace_corrupt',
  });
}

function localUrl(remote: string): boolean {
  return !/^https:\/\//.test(remote);
}

export class ManagedGitWorkspace implements GitWorkspacePort {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly credentials: GitCredentialPort,
    private readonly options: ManagedGitWorkspaceOptions = {},
  ) {}

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    const paths = deriveManagedWorkspacePaths(
      input.managedRoot,
      input.repositoryId,
      input.publicationRef,
    );
    const marker: WorktreeMarker = {
      schemaVersion: 1,
      publicationRef: input.publicationRef,
      repositoryId: input.repositoryId,
    };
    const cacheMarker: CacheMarker = {
      schemaVersion: 1,
      repositoryId: input.repositoryId,
    };
    const layout = await prepareManagedWorkspaceLayout(paths, this.options);

    if (!layout.cacheExists) {
      await this.expectOk(['init', '--bare', paths.cache]);
      await writeCacheMarker(paths, cacheMarker, this.options);
    } else {
      await assertOwnedCache(paths, cacheMarker, this.options);
    }
    await assertOwnedCache(paths, cacheMarker, this.options);
    await this.setRemote(paths.cache, 'upstream', input.upstreamRemote, true);
    await this.authenticated(input.upstreamRemote, (env) =>
      this.expectOk(
        [
          '--git-dir',
          paths.cache,
          'fetch',
          '--no-tags',
          'upstream',
          input.baseCommitSha,
        ],
        env,
      ),
    );

    if (layout.worktreeExists) {
      await assertOwnedManagedWorkspace(
        paths,
        cacheMarker,
        marker,
        this.options,
      );
    } else {
      await this.expectOk([
        '--git-dir',
        paths.cache,
        'worktree',
        'add',
        '--detach',
        paths.worktree,
        input.baseCommitSha,
      ]);
      await writeWorktreeMarker(paths, marker, this.options);
    }
    await assertOwnedManagedWorkspace(
      paths,
      cacheMarker,
      marker,
      this.options,
    );
    await this.expectOk([
      '-C',
      paths.worktree,
      'checkout',
      '--detach',
      input.baseCommitSha,
    ]);
    await this.expectOk([
      '-C',
      paths.worktree,
      'switch',
      '-C',
      input.branch,
      input.baseCommitSha,
    ]);
    await this.setRemote(paths.worktree, 'upstream', input.upstreamRemote, false);
    await this.setRemote(paths.worktree, 'push', input.pushRemote, false);
    return {
      paths,
      marker,
      baseCommitSha: input.baseCommitSha,
      branch: input.branch,
    };
  }

  async recover(input: RecoverWorkspaceInput): Promise<PreparedWorkspace> {
    const paths = deriveManagedWorkspacePaths(
      input.managedRoot,
      input.repositoryId,
      input.publicationRef,
    );
    const marker: WorktreeMarker = {
      schemaVersion: 1,
      publicationRef: input.publicationRef,
      repositoryId: input.repositoryId,
    };
    await assertOwnedManagedWorkspace(
      paths,
      { schemaVersion: 1, repositoryId: input.repositoryId },
      marker,
      this.options,
    );
    const [commit, tree] = await Promise.all([
      this.expectOk(['-C', paths.worktree, 'rev-parse', 'HEAD']),
      this.expectOk(['-C', paths.worktree, 'rev-parse', 'HEAD^{tree}']),
    ]);
    if (
      commit.stdout.trim() !== input.commitSha ||
      tree.stdout.trim() !== input.treeSha
    ) {
      unavailable('workspace_corrupt');
    }
    await this.setRemote(paths.worktree, 'upstream', input.upstreamRemote, false);
    await this.setRemote(paths.worktree, 'push', input.pushRemote, false);
    return {
      paths,
      marker,
      baseCommitSha: input.baseCommitSha,
      branch: input.branch,
    };
  }

  async write(
    workspace: PreparedWorkspace,
    bundle: ContributionBundle,
  ): Promise<void> {
    await this.assertOwned(workspace);
    await writeExactBundleFiles(
      workspace.paths.worktree,
      bundle.files,
      this.options,
    );
  }

  async commit(
    workspace: PreparedWorkspace,
    bundle: ContributionBundle,
  ): Promise<GitCommitIdentity> {
    await this.assertOwned(workspace);
    const paths = bundle.files.map((file) => file.path);
    await verifyExactBundleFiles(
      workspace.paths.worktree,
      bundle.files,
      this.options,
    );
    await this.expectOk(['-C', workspace.paths.worktree, 'add', '--', ...paths]);
    const staged = await this.expectOk([
      '-C',
      workspace.paths.worktree,
      'diff',
      '--cached',
      '--name-only',
      '-z',
    ]);
    const stagedPaths = staged.stdout.split('\0').filter(Boolean).sort();
    if (JSON.stringify(stagedPaths) !== JSON.stringify([...paths].sort())) {
      unavailable('workspace_corrupt');
    }
    const expectedBlobs = new Map<string, string>();
    for (const file of bundle.files) {
      const result = await this.runner.run(
        'git',
        ['-C', workspace.paths.worktree, 'hash-object', '--stdin'],
        { input: file.contents },
      );
      const objectId = result.stdout.trim();
      if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(objectId)) {
        unavailable('workspace_corrupt');
      }
      expectedBlobs.set(file.path, objectId);
    }
    const stagedEntries = await this.expectOk([
      '-C',
      workspace.paths.worktree,
      'ls-files',
      '--stage',
      '-z',
      '--',
      ...paths,
    ]);
    const observed = new Map<string, { mode: string; objectId: string }>();
    for (const entry of stagedEntries.stdout.split('\0').filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(entry);
      if (!match || observed.has(match[3])) unavailable('workspace_corrupt');
      observed.set(match[3], { mode: match[1], objectId: match[2] });
    }
    for (const file of bundle.files) {
      const entry = observed.get(file.path);
      if (
        !entry ||
        entry.mode !== '100644' ||
        entry.objectId !== expectedBlobs.get(file.path)
      ) {
        unavailable('workspace_corrupt');
      }
    }
    if (observed.size !== bundle.files.length) unavailable('workspace_corrupt');

    const stagedTree = (
      await this.expectOk(['-C', workspace.paths.worktree, 'write-tree'])
    ).stdout.trim();
    const expectedTree = await this.expectedTree(
      workspace,
      bundle,
      expectedBlobs,
    );
    if (
      !/^[a-f0-9]{40,64}$/.test(stagedTree) ||
      stagedTree !== expectedTree
    ) {
      unavailable('workspace_corrupt');
    }
    const message = `${bundle.commitMessage}\n\nMOSGA-Content-Digest: ${bundle.contentDigest}`;
    await this.expectOk([
      '-C',
      workspace.paths.worktree,
      '-c',
      'user.name=mosga',
      '-c',
      'user.email=mosga@localhost',
      'commit',
      '--no-verify',
      '-m',
      message,
    ]);
    const commitSha = (
      await this.expectOk(['-C', workspace.paths.worktree, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const treeSha = (
      await this.expectOk([
        '-C',
        workspace.paths.worktree,
        'rev-parse',
        'HEAD^{tree}',
      ])
    ).stdout.trim();
    const parent = (
      await this.expectOk(['-C', workspace.paths.worktree, 'rev-parse', 'HEAD^'])
    ).stdout.trim();
    if (
      !/^[a-f0-9]{40,64}$/.test(commitSha) ||
      !/^[a-f0-9]{40,64}$/.test(treeSha) ||
      treeSha !== expectedTree ||
      parent !== workspace.baseCommitSha
    ) {
      unavailable('workspace_corrupt');
    }
    return { commitSha, treeSha };
  }

  async push(
    workspace: PreparedWorkspace,
    identity: GitCommitIdentity,
  ): Promise<PushResult> {
    await this.assertOwned(workspace);
    const remote = (
      await this.expectOk([
        '-C',
        workspace.paths.worktree,
        'remote',
        'get-url',
        'push',
      ])
    ).stdout.trim();
    const existing = await this.authenticated(remote, (env) =>
      this.runner.run(
        'git',
        [
          '-C',
          workspace.paths.worktree,
          'ls-remote',
          '--heads',
          'push',
          `refs/heads/${workspace.branch}`,
        ],
        { env },
      ),
    );
    if (existing.code !== 0) unavailable('push_rejected');
    if (existing.stdout.trim()) {
      return this.compareRemoteTree(workspace, identity, remote);
    }
    const pushed = await this.authenticated(remote, (env) =>
      this.runner.run(
        'git',
        [
          '-C',
          workspace.paths.worktree,
          'push',
          'push',
          `HEAD:refs/heads/${workspace.branch}`,
        ],
        { env },
      ),
    );
    if (pushed.code === 0) {
      return { state: 'pushed', ...identity };
    }
    return this.compareRemoteTree(workspace, identity, remote);
  }

  private async assertOwned(workspace: PreparedWorkspace): Promise<void> {
    await assertOwnedManagedWorkspace(
      workspace.paths,
      {
        schemaVersion: 1,
        repositoryId: workspace.marker.repositoryId,
      },
      workspace.marker,
      this.options,
    );
  }

  private async expectedTree(
    workspace: PreparedWorkspace,
    bundle: ContributionBundle,
    blobs: ReadonlyMap<string, string>,
  ): Promise<string> {
    const indexPath = path.join(
      workspace.paths.root,
      `.mosga-sealed-index.${process.pid}.${randomUUID()}`,
    );
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await this.expectOk(
        [
          '-C',
          workspace.paths.worktree,
          'read-tree',
          `${workspace.baseCommitSha}^{tree}`,
        ],
        env,
      );
      for (const file of bundle.files) {
        const objectId = blobs.get(file.path);
        if (!objectId) unavailable('workspace_corrupt');
        await this.expectOk(
          [
            '-C',
            workspace.paths.worktree,
            'update-index',
            '--add',
            '--cacheinfo',
            `100644,${objectId},${file.path}`,
          ],
          env,
        );
      }
      const result = await this.expectOk(
        ['-C', workspace.paths.worktree, 'write-tree'],
        env,
      );
      const tree = result.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(tree)) unavailable('workspace_corrupt');
      return tree;
    } finally {
      await fs.promises.unlink(indexPath).catch(() => undefined);
    }
  }

  private async compareRemoteTree(
    workspace: PreparedWorkspace,
    identity: GitCommitIdentity,
    remote: string,
  ): Promise<PushResult> {
    const fetched = await this.authenticated(remote, (env) =>
      this.runner.run(
        'git',
        [
          '-C',
          workspace.paths.worktree,
          'fetch',
          '--no-tags',
          'push',
          `refs/heads/${workspace.branch}`,
        ],
        { env },
      ),
    );
    if (fetched.code !== 0) unavailable('push_rejected');
    const [remoteCommitResult, remoteTreeResult] = await Promise.all([
      this.expectOk([
        '-C',
        workspace.paths.worktree,
        'rev-parse',
        'FETCH_HEAD',
      ]),
      this.expectOk([
        '-C',
        workspace.paths.worktree,
        'rev-parse',
        'FETCH_HEAD^{tree}',
      ]),
    ]);
    const remoteCommit = remoteCommitResult.stdout.trim();
    const remoteTree = remoteTreeResult.stdout.trim();
    if (
      !/^[a-f0-9]{40,64}$/.test(remoteCommit) ||
      !/^[a-f0-9]{40,64}$/.test(remoteTree)
    ) {
      unavailable('workspace_corrupt');
    }
    return remoteTree === identity.treeSha
      ? {
          state: 'adopted',
          commitSha: remoteCommit,
          treeSha: remoteTree,
        }
      : { state: 'conflict' };
  }

  private async setRemote(
    repository: string,
    name: 'upstream' | 'push',
    url: string,
    bare: boolean,
  ): Promise<void> {
    const prefix = bare ? ['--git-dir', repository] : ['-C', repository];
    const current = await this.runner.run('git', [
      ...prefix,
      'remote',
      'get-url',
      name,
    ]);
    if (current.code === 0) {
      await this.expectOk([...prefix, 'remote', 'set-url', name, url]);
    } else {
      await this.expectOk([...prefix, 'remote', 'add', name, url]);
    }
  }

  private async authenticated<T>(
    remote: string,
    action: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    if (localUrl(remote)) return action({ ...process.env });
    return this.credentials.withCredentials((credentials) =>
      action({ ...process.env, ...credentials }),
    );
  }

  private async expectOk(
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<ProcessResult> {
    const result = await this.runner.run('git', args, { env });
    if (result.code !== 0) unavailable('workspace_unavailable');
    return result;
  }
}
