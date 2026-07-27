import { createHash } from 'node:crypto';
import fs, { type Stats } from 'node:fs';
import path from 'node:path';

import { PublicationError } from '../types.js';

export const WORKTREE_MARKER = '.mosga-publication-worktree.json';
export const CACHE_MARKER = '.mosga-publication-cache.json';

export interface ReparseProbe {
  isReparsePoint(path: string, stats: Stats): Promise<boolean>;
}

/**
 * Node reports Windows directory junctions and ordinary symlinks through
 * lstat().isSymbolicLink(). The injectable seam covers other platform-specific
 * reparse providers without making production safety depend on test doubles.
 */
export const defaultReparseProbe: ReparseProbe = {
  async isReparsePoint(_candidate, stats) {
    return stats.isSymbolicLink();
  },
};

export interface WorkspaceSafetyOptions {
  reparseProbe?: ReparseProbe;
}

export interface ManagedWorkspacePaths {
  root: string;
  cache: string;
  worktree: string;
  marker: string;
}

function workspaceError(): never {
  throw new PublicationError({
    code: 'workspace_corrupt',
    phase: 'workspace',
    message: 'The managed publication workspace is not safe to use.',
    retryable: false,
  });
}

function safePublicationRef(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return workspaceError();
  return value;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function deriveManagedWorkspacePaths(
  managedRoot: string,
  repositoryId: string,
  publicationRef: string,
): ManagedWorkspacePaths {
  if (
    managedRoot.length === 0 ||
    repositoryId.length === 0 ||
    repositoryId.length > 500
  ) {
    return workspaceError();
  }
  const root = path.resolve(managedRoot);
  const repositoryHash = createHash('sha256')
    .update(repositoryId, 'utf8')
    .digest('hex');
  const cache = path.join(root, 'cache', `${repositoryHash}.git`);
  const worktree = path.join(root, 'worktrees', safePublicationRef(publicationRef));
  if (!contained(root, cache) || !contained(root, worktree)) return workspaceError();
  return {
    root,
    cache,
    worktree,
    marker: path.join(worktree, WORKTREE_MARKER),
  };
}

export interface WorktreeMarker {
  schemaVersion: 1;
  publicationRef: string;
  repositoryId: string;
}

export interface CacheMarker {
  schemaVersion: 1;
  repositoryId: string;
}

async function lstatNoReparse(
  candidate: string,
  probe: ReparseProbe,
): Promise<Stats | null> {
  try {
    const stats = await fs.promises.lstat(candidate);
    if (
      stats.isSymbolicLink() ||
      (await probe.isReparsePoint(candidate, stats))
    ) {
      return workspaceError();
    }
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof PublicationError) throw error;
    return workspaceError();
  }
}

async function assertRealContained(
  rootReal: string,
  candidate: string,
): Promise<void> {
  const candidateReal = await fs.promises
    .realpath(candidate)
    .catch(() => workspaceError());
  if (!contained(rootReal, candidateReal)) return workspaceError();
}

async function ensureDirectory(
  candidate: string,
  probe: ReparseProbe,
  recursive: boolean,
): Promise<Stats> {
  let stats = await lstatNoReparse(candidate, probe);
  if (stats === null) {
    try {
      await fs.promises.mkdir(candidate, {
        recursive,
        mode: 0o700,
      });
    } catch {
      return workspaceError();
    }
    stats = await lstatNoReparse(candidate, probe);
  }
  if (!stats?.isDirectory()) return workspaceError();
  return stats;
}

/**
 * Establish the managed root and its fixed parents without following a
 * symlink/junction leaf. This runs before every Git command in prepare().
 */
export async function prepareManagedWorkspaceLayout(
  paths: ManagedWorkspacePaths,
  options: WorkspaceSafetyOptions = {},
): Promise<{ cacheExists: boolean; worktreeExists: boolean }> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  await ensureDirectory(paths.root, probe, true);
  const rootReal = await fs.promises
    .realpath(paths.root)
    .catch(() => workspaceError());
  for (const parent of [
    path.join(paths.root, 'cache'),
    path.join(paths.root, 'worktrees'),
  ]) {
    await ensureDirectory(parent, probe, false);
    await assertRealContained(rootReal, parent);
  }
  const cacheStats = await lstatNoReparse(paths.cache, probe);
  if (cacheStats && !cacheStats.isDirectory()) return workspaceError();
  if (cacheStats) await assertRealContained(rootReal, paths.cache);
  const worktreeStats = await lstatNoReparse(paths.worktree, probe);
  if (worktreeStats && !worktreeStats.isDirectory()) return workspaceError();
  if (worktreeStats) await assertRealContained(rootReal, paths.worktree);
  return {
    cacheExists: cacheStats !== null,
    worktreeExists: worktreeStats !== null,
  };
}

export async function writeCacheMarker(
  paths: ManagedWorkspacePaths,
  marker: CacheMarker,
  options: WorkspaceSafetyOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  const cacheStats = await lstatNoReparse(paths.cache, probe);
  if (!cacheStats?.isDirectory()) return workspaceError();
  const rootReal = await fs.promises
    .realpath(paths.root)
    .catch(() => workspaceError());
  await assertRealContained(rootReal, paths.cache);
  const markerPath = path.join(paths.cache, CACHE_MARKER);
  try {
    await fs.promises.writeFile(markerPath, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    workspaceError();
  }
}

export async function assertOwnedCache(
  paths: ManagedWorkspacePaths,
  marker: CacheMarker,
  options: WorkspaceSafetyOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  try {
    const rootStats = await lstatNoReparse(paths.root, probe);
    const cacheParent = await lstatNoReparse(
      path.join(paths.root, 'cache'),
      probe,
    );
    const cacheStats = await lstatNoReparse(paths.cache, probe);
    if (
      !rootStats?.isDirectory() ||
      !cacheParent?.isDirectory() ||
      !cacheStats?.isDirectory()
    ) {
      return workspaceError();
    }
    const rootReal = await fs.promises.realpath(paths.root);
    await assertRealContained(rootReal, path.join(paths.root, 'cache'));
    await assertRealContained(rootReal, paths.cache);
    const markerPath = path.join(paths.cache, CACHE_MARKER);
    const markerStats = await lstatNoReparse(markerPath, probe);
    if (!markerStats?.isFile()) return workspaceError();
    const parsed = JSON.parse(
      await fs.promises.readFile(markerPath, 'utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as CacheMarker).schemaVersion !== 1 ||
      (parsed as CacheMarker).repositoryId !== marker.repositoryId ||
      Object.keys(parsed).some(
        (key) => key !== 'schemaVersion' && key !== 'repositoryId',
      )
    ) {
      return workspaceError();
    }
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    workspaceError();
  }
}

export async function writeWorktreeMarker(
  paths: ManagedWorkspacePaths,
  marker: WorktreeMarker,
  options: WorkspaceSafetyOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  try {
    const rootReal = await fs.promises.realpath(paths.root);
    const parent = path.join(paths.root, 'worktrees');
    const parentStats = await lstatNoReparse(parent, probe);
    const worktreeStats = await lstatNoReparse(paths.worktree, probe);
    if (!parentStats?.isDirectory() || !worktreeStats?.isDirectory()) {
      return workspaceError();
    }
    await assertRealContained(rootReal, parent);
    await assertRealContained(rootReal, paths.worktree);
    await fs.promises.writeFile(paths.marker, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    workspaceError();
  }
}

export async function assertOwnedWorktree(
  paths: ManagedWorkspacePaths,
  marker: WorktreeMarker,
  options: WorkspaceSafetyOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  try {
    const rootStats = await lstatNoReparse(paths.root, probe);
    const worktreeParent = await lstatNoReparse(
      path.join(paths.root, 'worktrees'),
      probe,
    );
    const worktreeStats = await lstatNoReparse(paths.worktree, probe);
    if (
      !rootStats?.isDirectory() ||
      !worktreeParent?.isDirectory() ||
      !worktreeStats?.isDirectory()
    ) {
      return workspaceError();
    }
    const rootReal = await fs.promises.realpath(paths.root);
    await assertRealContained(rootReal, path.join(paths.root, 'worktrees'));
    const worktreeReal = await fs.promises.realpath(paths.worktree);
    if (!contained(rootReal, worktreeReal)) return workspaceError();
    const stat = await lstatNoReparse(paths.marker, probe);
    if (!stat?.isFile()) return workspaceError();
    const parsed = JSON.parse(
      await fs.promises.readFile(paths.marker, 'utf8'),
    ) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as WorktreeMarker).schemaVersion !== 1 ||
      (parsed as WorktreeMarker).publicationRef !== marker.publicationRef ||
      (parsed as WorktreeMarker).repositoryId !== marker.repositoryId
    ) {
      return workspaceError();
    }
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    workspaceError();
  }
}

export async function assertOwnedManagedWorkspace(
  paths: ManagedWorkspacePaths,
  cacheMarker: CacheMarker,
  worktreeMarker: WorktreeMarker,
  options: WorkspaceSafetyOptions = {},
): Promise<void> {
  await assertOwnedCache(paths, cacheMarker, options);
  await assertOwnedWorktree(paths, worktreeMarker, options);
}

export async function cleanupOwnedWorktree(
  paths: ManagedWorkspacePaths,
  marker: WorktreeMarker,
): Promise<void> {
  await assertOwnedWorktree(paths, marker);
  const rootReal = await fs.promises.realpath(paths.root).catch(() => workspaceError());
  const worktreeReal = await fs.promises
    .realpath(paths.worktree)
    .catch(() => workspaceError());
  if (!contained(rootReal, worktreeReal)) return workspaceError();
  await fs.promises.rm(worktreeReal, { recursive: true, force: false }).catch(() => {
    workspaceError();
  });
}
