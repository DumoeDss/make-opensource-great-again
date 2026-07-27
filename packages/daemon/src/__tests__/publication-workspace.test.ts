import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SanitizedSession } from '@mosga/contracts';
import { compileContributionBundle } from '@mosga/publisher';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FakeGitCredentialPort,
  FakeProcessRunner,
  ManagedGitWorkspace,
  ProcessExecutionError,
  SpawnProcessRunner,
  assertOwnedWorktree,
  cleanupOwnedWorktree,
  deriveManagedWorkspacePaths,
  writeExactBundleFiles,
  writeWorktreeMarker,
  type WorktreeMarker,
} from '../publication/index.js';

const roots: string[] = [];

function root(prefix = 'mosga-publication-workspace-'): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRemote(): { bare: string; baseSha: string } {
  const base = root('mosga-local-remote-');
  const bare = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  git(['init', '--bare', bare]);
  fs.mkdirSync(seed);
  git(['init', '--initial-branch=main'], seed);
  git(['config', 'user.name', 'Test'], seed);
  git(['config', 'user.email', 'test@example.invalid'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'base\n', 'utf8');
  git(['add', '--', 'README.md'], seed);
  git(['commit', '-m', 'base'], seed);
  const baseSha = git(['rev-parse', 'HEAD'], seed);
  git(['remote', 'add', 'upstream', bare], seed);
  git(['push', 'upstream', 'main'], seed);
  return { bare, baseSha };
}

function stampedSession(id = 'session'): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: '1.0.0',
      sanitizationRulesetVersion: 'rules',
      exportedAt: '2026-07-27T00:00:00.000Z',
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
        content: 'clean exact content',
        sdkMessageType: 'message',
        timestamp: 1,
      },
    ],
  };
}

describe('backend-owned process runner', () => {
  it('uses argument arrays/shell false and captures bounded output', async () => {
    const runner = new SpawnProcessRunner();
    const literal = '$(definitely-not-a-command); & echo unsafe';
    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      literal,
    ]);
    expect(result.stdout).toBe(literal);

    const error = await runner
      .run(
        process.execPath,
        ['-e', "process.stdout.write('sensitive'.repeat(100))"],
        { maxOutputBytes: 10 },
      )
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect(error).toMatchObject({
      kind: 'output_limit',
      message: 'External command failed.',
    });
    expect(JSON.stringify(error)).not.toContain('sensitive');
  });
});

describe('managed layout ownership', () => {
  it('hashes repository IDs independently of slugs and validates marker-contained cleanup', async () => {
    const managedRoot = root();
    const first = deriveManagedWorkspacePaths(managedRoot, 'R_123', 'publication_1');
    const same = deriveManagedWorkspacePaths(managedRoot, 'R_123', 'publication_2');
    const other = deriveManagedWorkspacePaths(managedRoot, 'R_456', 'publication_3');
    expect(path.basename(first.cache)).toBe(path.basename(same.cache));
    expect(path.basename(first.cache)).not.toBe(path.basename(other.cache));
    expect(first.cache).not.toContain('owner');
    expect(first.cache).not.toContain('repo');

    await fs.promises.mkdir(first.worktree, { recursive: true });
    const marker: WorktreeMarker = {
      schemaVersion: 1,
      publicationRef: 'publication_1',
      repositoryId: 'R_123',
    };
    await expect(cleanupOwnedWorktree(first, marker)).rejects.toMatchObject({
      body: { code: 'workspace_corrupt' },
    });
    await writeWorktreeMarker(first, marker);
    await assertOwnedWorktree(first, marker);
    await cleanupOwnedWorktree(first, marker);
    expect(fs.existsSync(first.worktree)).toBe(false);

    const escaped = {
      ...first,
      worktree: path.dirname(managedRoot),
      marker: path.join(path.dirname(managedRoot), '.missing-marker'),
    };
    await expect(cleanupOwnedWorktree(escaped, marker)).rejects.toMatchObject({
      body: { code: 'workspace_corrupt' },
    });
  });
});

describe('exact-byte writer', () => {
  it('writes and verifies exact UTF-8 bytes while rejecting traversal and reparse escapes', async () => {
    const worktree = root();
    const bundle = compileContributionBundle([stampedSession('会话%2Fid')], {
      generatedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
    });
    await writeExactBundleFiles(worktree, bundle.files);
    for (const file of bundle.files) {
      expect(fs.readFileSync(path.join(worktree, ...file.path.split('/')))).toEqual(
        Buffer.from(file.contents, 'utf8'),
      );
    }

    const traversal = { ...bundle.files[0], path: 'data/../../escape.jsonl' };
    await expect(writeExactBundleFiles(worktree, [traversal])).rejects.toMatchObject({
      body: { code: 'preview_stale' },
    });

    const outside = root('mosga-writer-outside-');
    const link = path.join(worktree, 'data', 'linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = {
      ...bundle.files[0],
      path: 'data/linked/escape.jsonl',
    };
    await expect(writeExactBundleFiles(worktree, [linked])).rejects.toMatchObject({
      body: { code: 'workspace_corrupt' },
    });
    expect(fs.existsSync(path.join(outside, 'escape.jsonl'))).toBe(false);

    await expect(
      writeExactBundleFiles(worktree, [bundle.files[0]], {
        reparseProbe: {
          async isReparsePoint(candidate) {
            return path.basename(candidate) === 'data';
          },
        },
      }),
    ).rejects.toMatchObject({ body: { code: 'workspace_corrupt' } });
  });
});

describe('local managed Git integration', () => {
  it('rejects a bundle file changed after write before it can enter the index', { timeout: 60_000 }, async () => {
    const upstream = createRemote();
    const workspacePort = new ManagedGitWorkspace(
      new SpawnProcessRunner(),
      new FakeGitCredentialPort(),
    );
    const bundle = compileContributionBundle([stampedSession('race')], {
      generatedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
    });
    const workspace = await workspacePort.prepare({
      managedRoot: root(),
      publicationRef: 'publication_race',
      repositoryId: 'R_upstream',
      upstreamRemote: upstream.bare,
      pushRemote: upstream.bare,
      baseCommitSha: upstream.baseSha,
      branch: bundle.branch,
    });
    await workspacePort.write(workspace, bundle);
    fs.writeFileSync(
      path.join(workspace.paths.worktree, ...bundle.files[0].path.split('/')),
      'changed after sealed write\n',
      'utf8',
    );
    await expect(workspacePort.commit(workspace, bundle)).rejects.toMatchObject({
      body: { code: 'workspace_corrupt' },
    });
    expect(git(['diff', '--cached', '--name-only'], workspace.paths.worktree)).toBe('');
  });

  it('rejects real cache/parent links and injected reparse points before Git runs', { timeout: 60_000 }, async () => {
    for (const linkedName of ['cache', 'worktrees'] as const) {
      const managedRoot = root(`mosga-${linkedName}-link-root-`);
      const outside = root(`mosga-${linkedName}-link-outside-`);
      fs.symlinkSync(
        outside,
        path.join(managedRoot, linkedName),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const runner = new FakeProcessRunner();
      const port = new ManagedGitWorkspace(runner, new FakeGitCredentialPort());
      await expect(
        port.prepare({
          managedRoot,
          publicationRef: `publication_${linkedName}`,
          repositoryId: 'R_linked',
          upstreamRemote: 'local-upstream',
          pushRemote: 'local-push',
          baseCommitSha: 'a'.repeat(40),
          branch: 'contrib/alias/session-aaaaaaaa',
        }),
      ).rejects.toMatchObject({ body: { code: 'workspace_corrupt' } });
      expect(runner.calls).toEqual([]);
    }

    const cacheLeafRoot = root('mosga-cache-leaf-link-root-');
    const cacheLeafOutside = root('mosga-cache-leaf-link-outside-');
    const cacheLeafPaths = deriveManagedWorkspacePaths(
      cacheLeafRoot,
      'R_cache_leaf',
      'publication_cache_leaf',
    );
    fs.mkdirSync(path.dirname(cacheLeafPaths.cache), { recursive: true });
    fs.mkdirSync(path.join(cacheLeafRoot, 'worktrees'));
    fs.symlinkSync(
      cacheLeafOutside,
      cacheLeafPaths.cache,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const cacheLeafRunner = new FakeProcessRunner();
    await expect(
      new ManagedGitWorkspace(
        cacheLeafRunner,
        new FakeGitCredentialPort(),
      ).prepare({
        managedRoot: cacheLeafRoot,
        publicationRef: 'publication_cache_leaf',
        repositoryId: 'R_cache_leaf',
        upstreamRemote: 'local-upstream',
        pushRemote: 'local-push',
        baseCommitSha: 'a'.repeat(40),
        branch: 'contrib/alias/session-aaaaaaaa',
      }),
    ).rejects.toMatchObject({ body: { code: 'workspace_corrupt' } });
    expect(cacheLeafRunner.calls).toEqual([]);

    const managedRoot = root('mosga-injected-reparse-root-');
    fs.mkdirSync(path.join(managedRoot, 'cache'));
    fs.mkdirSync(path.join(managedRoot, 'worktrees'));
    const runner = new FakeProcessRunner();
    const port = new ManagedGitWorkspace(
      runner,
      new FakeGitCredentialPort(),
      {
        reparseProbe: {
          async isReparsePoint(candidate) {
            return path.basename(candidate) === 'cache';
          },
        },
      },
    );
    await expect(
      port.prepare({
        managedRoot,
        publicationRef: 'publication_injected',
        repositoryId: 'R_injected',
        upstreamRemote: 'local-upstream',
        pushRemote: 'local-push',
        baseCommitSha: 'a'.repeat(40),
        branch: 'contrib/alias/session-aaaaaaaa',
      }),
    ).rejects.toMatchObject({ body: { code: 'workspace_corrupt' } });
    expect(runner.calls).toEqual([]);
  });

  it('commits exact sealed bytes from the sealed base and pushes explicitly without origin', { timeout: 60_000 }, async () => {
    const upstream = createRemote();
    const managedRoot = root();
    const credentials = new FakeGitCredentialPort();
    const workspacePort = new ManagedGitWorkspace(
      new SpawnProcessRunner(),
      credentials,
    );
    const bundle = compileContributionBundle([stampedSession()], {
      generatedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
    });
    const workspace = await workspacePort.prepare({
      managedRoot,
      publicationRef: 'publication_1',
      repositoryId: 'R_upstream',
      upstreamRemote: upstream.bare,
      pushRemote: upstream.bare,
      baseCommitSha: upstream.baseSha,
      branch: bundle.branch,
    });
    expect(() =>
      git(['remote', 'get-url', 'origin'], workspace.paths.worktree),
    ).toThrow();
    await workspacePort.write(workspace, bundle);
    fs.writeFileSync(path.join(workspace.paths.worktree, 'UNTRACKED.txt'), 'not staged\n');
    const identity = await workspacePort.commit(workspace, bundle);
    expect(git(['rev-parse', `${identity.commitSha}^`], workspace.paths.worktree)).toBe(
      upstream.baseSha,
    );
    expect(git(['status', '--porcelain'], workspace.paths.worktree)).toContain(
      '?? UNTRACKED.txt',
    );
    for (const file of bundle.files) {
      const shown = execFileSync(
        'git',
        ['show', `${identity.commitSha}:${file.path}`],
        { cwd: workspace.paths.worktree },
      );
      expect(shown).toEqual(Buffer.from(file.contents, 'utf8'));
    }
    const firstPush = await workspacePort.push(workspace, identity);
    expect(firstPush.state).toBe('pushed');
    expect(
      git([
        '--git-dir',
        upstream.bare,
        'rev-parse',
        `refs/heads/${bundle.branch}^{tree}`,
      ]),
    ).toBe(identity.treeSha);
    expect(credentials.calls).toBe(0);

    git(['remote', 'add', 'origin', path.join(managedRoot, 'unrelated.git')], workspace.paths.worktree);
    expect((await workspacePort.push(workspace, identity)).state).toBe('adopted');

    const equivalentCommit = git(
      [
        '--git-dir',
        upstream.bare,
        '-c',
        'user.name=Equivalent',
        '-c',
        'user.email=equivalent@example.invalid',
        'commit-tree',
        identity.treeSha,
        '-p',
        upstream.baseSha,
        '-m',
        'equivalent tree',
      ],
    );
    expect(equivalentCommit).not.toBe(identity.commitSha);
    git([
      '--git-dir',
      upstream.bare,
      'update-ref',
      `refs/heads/${bundle.branch}`,
      equivalentCommit,
    ]);
    await expect(workspacePort.push(workspace, identity)).resolves.toEqual({
      state: 'adopted',
      commitSha: equivalentCommit,
      treeSha: identity.treeSha,
    });
  });

  it('uses the fork push repository and refuses a different-tree branch collision', { timeout: 60_000 }, async () => {
    const upstream = createRemote();
    const fork = createRemote();
    const managedRoot = root();
    const workspacePort = new ManagedGitWorkspace(
      new SpawnProcessRunner(),
      new FakeGitCredentialPort(),
    );
    const bundle = compileContributionBundle([stampedSession('forked')], {
      generatedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
    });
    const workspace = await workspacePort.prepare({
      managedRoot,
      publicationRef: 'publication_fork',
      repositoryId: 'R_upstream',
      upstreamRemote: upstream.bare,
      pushRemote: fork.bare,
      baseCommitSha: upstream.baseSha,
      branch: bundle.branch,
    });
    await workspacePort.write(workspace, bundle);
    const identity = await workspacePort.commit(workspace, bundle);
    expect((await workspacePort.push(workspace, identity)).state).toBe('pushed');
    expect(
      git(['--git-dir', fork.bare, 'show-ref', '--verify', `refs/heads/${bundle.branch}`]),
    ).toContain(bundle.branch);
    expect(() =>
      git(['--git-dir', upstream.bare, 'show-ref', '--verify', `refs/heads/${bundle.branch}`]),
    ).toThrow();

    const clone = path.join(root(), 'collision-clone');
    git(['clone', '--branch', bundle.branch, fork.bare, clone]);
    git(['config', 'user.name', 'Collision'], clone);
    git(['config', 'user.email', 'collision@example.invalid'], clone);
    fs.writeFileSync(path.join(clone, 'different.txt'), 'different tree\n', 'utf8');
    git(['add', '--', 'different.txt'], clone);
    git(['commit', '-m', 'different tree'], clone);
    git(['push', 'origin', bundle.branch], clone);
    expect((await workspacePort.push(workspace, identity)).state).toBe('conflict');
  });
});
