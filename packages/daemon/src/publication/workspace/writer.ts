import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

import type { ContributionBundleFile } from '@mosga/publisher';

import { canonicalPortablePath } from '../bundle-validator.js';
import { sha256Utf8 } from '../target.js';
import { PublicationError } from '../types.js';
import {
  defaultReparseProbe,
  type ReparseProbe,
} from './layout.js';

export interface ExactWriterOptions {
  reparseProbe?: ReparseProbe;
}

function corrupt(): never {
  throw new PublicationError({
    code: 'workspace_corrupt',
    phase: 'workspace',
    message: 'The managed publication workspace is not safe to use.',
    retryable: false,
  });
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    corrupt();
  }
}

async function rejectLink(
  candidate: string,
  probe: ReparseProbe,
): Promise<Stats | null> {
  try {
    const stats = await fs.promises.lstat(candidate);
    if (stats.isSymbolicLink() || (await probe.isReparsePoint(candidate, stats))) {
      return corrupt();
    }
    return stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return corrupt();
  }
}

export async function writeExactBundleFiles(
  worktree: string,
  files: readonly ContributionBundleFile[],
  options: ExactWriterOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  const root = path.resolve(worktree);
  const rootStats = await rejectLink(root, probe);
  if (!rootStats?.isDirectory()) return corrupt();
  const portable = new Set<string>();

  for (const file of files) {
    const collisionKey = canonicalPortablePath(file.path);
    if (portable.has(collisionKey)) return corrupt();
    portable.add(collisionKey);
    const segments = file.path.split('/');
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      const next = path.resolve(parent, segment);
      assertContained(root, next);
      const stats = await rejectLink(next, probe);
      if (stats === null) {
        try {
          await fs.promises.mkdir(next, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return corrupt();
        }
        const created = await rejectLink(next, probe);
        if (!created?.isDirectory()) return corrupt();
      } else if (!stats.isDirectory()) {
        return corrupt();
      }
      parent = next;
    }
    const destination = path.resolve(parent, segments.at(-1) as string);
    assertContained(root, destination);
    const existing = await rejectLink(destination, probe);
    if (existing && !existing.isFile()) return corrupt();
    const noFollow = (fsConstants as Record<string, number>).O_NOFOLLOW ?? 0;
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(
        destination,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          noFollow,
        0o600,
      );
    } catch {
      return corrupt();
    }
    try {
      await handle.writeFile(file.contents, { encoding: 'utf8' });
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const exact = await fs.promises.readFile(destination);
    if (
      exact.length !== file.bytes ||
      sha256Utf8(exact.toString('utf8')) !== file.contentHash ||
      !exact.equals(Buffer.from(file.contents, 'utf8'))
    ) {
      return corrupt();
    }
  }
}

/**
 * Re-read every sealed file immediately before Git stages it. This closes the
 * write-to-index race: the later index/blob checks still remain authoritative
 * if bytes change between this read and `git add`.
 */
export async function verifyExactBundleFiles(
  worktree: string,
  files: readonly ContributionBundleFile[],
  options: ExactWriterOptions = {},
): Promise<void> {
  const probe = options.reparseProbe ?? defaultReparseProbe;
  const root = path.resolve(worktree);
  const rootStats = await rejectLink(root, probe);
  if (!rootStats?.isDirectory()) return corrupt();
  const portable = new Set<string>();

  for (const file of files) {
    const collisionKey = canonicalPortablePath(file.path);
    if (portable.has(collisionKey)) return corrupt();
    portable.add(collisionKey);
    const segments = file.path.split('/');
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      const next = path.resolve(parent, segment);
      assertContained(root, next);
      const stats = await rejectLink(next, probe);
      if (!stats?.isDirectory()) return corrupt();
      parent = next;
    }
    const destination = path.resolve(parent, segments.at(-1) as string);
    assertContained(root, destination);
    const stats = await rejectLink(destination, probe);
    if (!stats?.isFile()) return corrupt();
    let exact: Buffer;
    try {
      exact = await fs.promises.readFile(destination);
    } catch {
      return corrupt();
    }
    if (
      exact.length !== file.bytes ||
      sha256Utf8(exact.toString('utf8')) !== file.contentHash ||
      !exact.equals(Buffer.from(file.contents, 'utf8'))
    ) {
      return corrupt();
    }
  }
}
