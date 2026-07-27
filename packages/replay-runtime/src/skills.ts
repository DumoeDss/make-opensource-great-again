import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { CapabilityProfile } from './adapters/types.js';
import type { RuntimeConfig } from './config.js';
import { RuntimeFault } from './errors.js';
import type { ReplaySkillRoot } from './types.js';
import type { ReplayWorkspace } from './workspace.js';

interface CopyBudget {
  files: number;
  bytes: number;
}

export interface SkillSnapshotHooks {
  afterEntryValidated?(
    sourcePath: string,
    kind: 'directory' | 'file',
  ): void | Promise<void>;
  afterFileOpened?(sourcePath: string): void | Promise<void>;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function containedOrEqual(root: string, candidate: string): boolean {
  return path.resolve(root) === path.resolve(candidate) ||
    contained(root, candidate);
}

interface StableStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function hasStableIdentity(stats: StableStats): boolean {
  return stats.dev !== 0n && stats.ino !== 0n && stats.size >= 0n;
}

function sameIdentity(left: StableStats, right: StableStats): boolean {
  return (
    hasStableIdentity(left) &&
    hasStableIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function assertCurrentIdentity(
  sourceRoot: string,
  source: string,
  expected: StableStats,
  kind: 'directory' | 'file',
): Promise<void> {
  const current = await lstat(source, { bigint: true });
  const resolved = await realpath(source);
  if (
    current.isSymbolicLink() ||
    (kind === 'directory'
      ? !current.isDirectory()
      : !current.isFile()) ||
    !containedOrEqual(sourceRoot, resolved) ||
    !sameIdentity(expected, current)
  ) {
    throw new RuntimeFault('skill-exposure-failed', 'materialize');
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function createPrivateDirectory(
  workspaceRoot: string,
  destination: string,
): Promise<void> {
  if (!contained(workspaceRoot, destination)) {
    throw new RuntimeFault('skill-exposure-failed', 'materialize');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const stats = await lstat(destination);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RuntimeFault('skill-exposure-failed', 'materialize');
  }
}

async function copySkillTree(
  sourceRoot: string,
  currentSource: string,
  destinationRoot: string,
  relative: string,
  workspaceRoot: string,
  occupiedFiles: Set<string>,
  budget: CopyBudget,
  config: RuntimeConfig,
  directories: string[],
  hooks: SkillSnapshotHooks,
): Promise<void> {
  const directoryStats = await lstat(currentSource, { bigint: true });
  const directoryReal = await realpath(currentSource);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !containedOrEqual(sourceRoot, directoryReal) ||
    !hasStableIdentity(directoryStats)
  ) {
    throw new RuntimeFault('skill-exposure-failed', 'materialize');
  }
  await hooks.afterEntryValidated?.(currentSource, 'directory');
  await assertCurrentIdentity(
    sourceRoot,
    currentSource,
    directoryStats,
    'directory',
  );
  const entries = await readdir(currentSource);
  entries.sort(compareNames);
  for (const name of entries) {
    if (
      name.length === 0 ||
      name === '.' ||
      name === '..' ||
      name.includes('\0') ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    const source = path.join(currentSource, name);
    const sourceStats = await lstat(source, { bigint: true });
    if (sourceStats.isSymbolicLink()) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    const resolvedSource = await realpath(source);
    if (
      !contained(sourceRoot, resolvedSource) ||
      !hasStableIdentity(sourceStats)
    ) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    const childRelative =
      relative.length === 0 ? name : path.join(relative, name);
    const normalizedCollisionKey =
      process.platform === 'win32'
        ? childRelative.toLowerCase()
        : childRelative;
    const destination = path.join(destinationRoot, childRelative);
    if (!contained(workspaceRoot, destination)) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    if (sourceStats.isDirectory()) {
      await hooks.afterEntryValidated?.(source, 'directory');
      await assertCurrentIdentity(
        sourceRoot,
        source,
        sourceStats,
        'directory',
      );
      try {
        const destinationStats = await lstat(destination);
        if (
          !destinationStats.isDirectory() ||
          destinationStats.isSymbolicLink()
        ) {
          throw new RuntimeFault(
            'skill-exposure-failed',
            'materialize',
          );
        }
      } catch (error) {
        if (error instanceof RuntimeFault) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(destination, { mode: 0o700 });
        directories.push(destination);
      }
      await copySkillTree(
        sourceRoot,
        source,
        destinationRoot,
        childRelative,
        workspaceRoot,
        occupiedFiles,
        budget,
        config,
        directories,
        hooks,
      );
      continue;
    }
    if (!sourceStats.isFile() || occupiedFiles.has(normalizedCollisionKey)) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    if (
      sourceStats.size > BigInt(config.limits.skillFileBytes) ||
      budget.files + 1 > config.limits.skillFileCount ||
      budget.bytes + Number(sourceStats.size) >
        config.limits.skillTotalBytes
    ) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    await hooks.afterEntryValidated?.(source, 'file');
    const sourceHandle = await open(
      source,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      const openedStats = await sourceHandle.stat({ bigint: true });
      if (
        !openedStats.isFile() ||
        !sameIdentity(sourceStats, openedStats)
      ) {
        throw new RuntimeFault(
          'skill-exposure-failed',
          'materialize',
        );
      }
      await assertCurrentIdentity(
        sourceRoot,
        source,
        openedStats,
        'file',
      );
      await hooks.afterFileOpened?.(source);
      await assertCurrentIdentity(
        sourceRoot,
        source,
        openedStats,
        'file',
      );
      bytes = await sourceHandle.readFile();
      const finalOpenedStats = await sourceHandle.stat({ bigint: true });
      if (!sameIdentity(openedStats, finalOpenedStats)) {
        throw new RuntimeFault(
          'skill-exposure-failed',
          'materialize',
        );
      }
      await assertCurrentIdentity(
        sourceRoot,
        source,
        openedStats,
        'file',
      );
    } finally {
      await sourceHandle.close();
    }
    if (bytes.byteLength !== Number(sourceStats.size)) {
      throw new RuntimeFault('skill-exposure-failed', 'materialize');
    }
    await createPrivateDirectory(workspaceRoot, path.dirname(destination));
    const readOnlyMode =
      process.platform === 'win32'
        ? 0o400
        : Number(sourceStats.mode & 0o555n) || 0o400;
    const handle = await open(destination, 'wx', readOnlyMode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(destination, readOnlyMode);
    occupiedFiles.add(normalizedCollisionKey);
    budget.files += 1;
    budget.bytes += bytes.byteLength;
  }
  await assertCurrentIdentity(
    sourceRoot,
    currentSource,
    directoryStats,
    'directory',
  );
}

export async function exposeSkillSnapshots(
  roots: readonly ReplaySkillRoot[],
  profile: CapabilityProfile,
  workspace: ReplayWorkspace,
  config: RuntimeConfig,
  hooks: SkillSnapshotHooks = {},
): Promise<void> {
  if (roots.length === 0) return;
  const locations = profile.skillLocations(workspace.paths);
  const occupied: Record<'user' | 'project', Set<string>> = {
    user: new Set<string>(),
    project: new Set<string>(),
  };
  const budget: CopyBudget = { files: 0, bytes: 0 };
  const directories: string[] = [];
  try {
    for (const root of roots) {
      let sourceStats;
      try {
        sourceStats = await lstat(root.sourcePath);
      } catch {
        throw new RuntimeFault('skill-root-invalid', 'materialize');
      }
      if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        throw new RuntimeFault('skill-root-invalid', 'materialize');
      }
      const sourceReal = await realpath(root.sourcePath);
      if (path.resolve(sourceReal) !== path.resolve(root.sourcePath)) {
        throw new RuntimeFault('skill-root-invalid', 'materialize');
      }
      const destinationRoot = locations[root.scope];
      await createPrivateDirectory(
        workspace.paths.root,
        destinationRoot,
      );
      directories.push(destinationRoot);
      await copySkillTree(
        sourceReal,
        sourceReal,
        destinationRoot,
        '',
        workspace.paths.root,
        occupied[root.scope],
        budget,
        config,
        directories,
        hooks,
      );
    }
    directories.sort(
      (left, right) => right.length - left.length || compareNames(left, right),
    );
    for (const directory of directories) {
      await chmod(directory, 0o500);
    }
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw new RuntimeFault(
      'skill-exposure-failed',
      'materialize',
      profile.sourceCli,
    );
  }
}
