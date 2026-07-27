// Runtime-owned immutable executable copy (closes STD-M1).
//
// The verified CLI binary is COPIED into the private replay runtime dir under
// a random unguessable name, made non-writable, and its identity is captured
// FROM THE COPY. The supervisor never spawns the original caller-resolved
// path; it spawns the owned copy, and re-verifies that copy's identity
// synchronously inside the spawn path (verifyOwnedExecutable). A same-size
// replacement at the original path after staging therefore has no effect —
// the comparison and the spawn both target the owned copy.
import { randomUUID } from 'node:crypto';
import { chmod, copyFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { SourceCli } from '@mosga/contracts';

import {
  captureExecutableIdentity,
  executableIdentityMatches,
  type ExecutableIdentity,
} from './adapters/capabilityProbe.js';
import { RuntimeFault } from './errors.js';

export interface OwnedExecutable {
  /** Random path inside the replay runtime dir; the only path ever spawned. */
  readonly runtimePath: string;
  /** Identity captured from runtimePath AFTER staging. */
  readonly identity: ExecutableIdentity;
}

function extensionFor(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

/**
 * Copy the verified executable into the private replay runtime dir under a
 * random name, strip write bits, and capture the copy's identity. Asserts the
 * copy's identity matches the probed identity. Returns the frozen
 * OwnedExecutable that the supervisor will spawn.
 */
export async function stageOwnedExecutable(
  originalPath: string,
  runtimeDir: string,
  probedIdentity: ExecutableIdentity,
  sourceCli: SourceCli,
): Promise<OwnedExecutable> {
  const randomName = `cli-${randomUUID()}${extensionFor()}`;
  // Defense in depth: the staged name must be a bare filename (no separators),
  // so the resolved path always stays directly inside the private runtime dir.
  if (
    randomName.includes(path.sep) ||
    randomName.includes('/') ||
    randomName.includes('\\')
  ) {
    throw new RuntimeFault('cli-capability-unsupported', 'probe', sourceCli);
  }
  const runtimePath = path.resolve(runtimeDir, randomName);

  // Re-verify the SOURCE identity before copying: the original path may have
  // been swapped between the probe and staging.
  const sourceIdentity = await captureExecutableIdentity(
    originalPath,
    sourceCli,
  );
  if (!executableIdentityMatches(probedIdentity, sourceIdentity)) {
    throw new RuntimeFault('cli-capability-unsupported', 'probe', sourceCli);
  }

  // Exclusive-create copy: fails if the random name already exists. The runtime
  // dir is private (0o700) and the name is a UUID, so collision is effectively
  // impossible — COPYFILE_EXCL makes the guarantee explicit.
  await copyFile(originalPath, runtimePath, fsConstants.COPYFILE_EXCL);

  // Strip write bits. On POSIX this is a real mode change (0o500). On Windows,
  // Node's chmod only toggles the read-only bit — a hint; the real guarantee is
  // the random private path plus the pre-spawn identity re-check.
  await chmod(runtimePath, 0o500).catch(() => {});

  // Capture the identity FROM THE COPY. This is the identity the spawn path
  // re-verifies immediately before host.spawn. The comparison to the source is
  // CONTENT-ONLY (size + digest): the copy is a new file with a different
  // inode, so a full identity match (which includes path + inode) would always
  // fail. Content equality proves the copy reflects the verified source bytes.
  const copyIdentity = await captureExecutableIdentity(runtimePath, sourceCli);
  if (
    copyIdentity.size !== sourceIdentity.size ||
    copyIdentity.digest !== sourceIdentity.digest
  ) {
    throw new RuntimeFault('cli-capability-unsupported', 'probe', sourceCli);
  }

  return Object.freeze({ runtimePath, identity: copyIdentity });
}

/**
 * Re-verify the owned copy's identity immediately before spawn. Called inside
 * the supervisor, synchronously before host.spawn. On any mismatch or capture
 * error, rejects with cli-capability-unsupported (stage launch) WITHOUT
 * spawning — the atomic check/use gate the spec requires.
 */
export async function verifyOwnedExecutable(
  owned: OwnedExecutable,
  sourceCli: SourceCli,
): Promise<void> {
  let current: ExecutableIdentity;
  try {
    current = await captureExecutableIdentity(owned.runtimePath, sourceCli);
  } catch {
    throw new RuntimeFault(
      'cli-capability-unsupported',
      'launch',
      sourceCli,
    );
  }
  if (!executableIdentityMatches(owned.identity, current)) {
    throw new RuntimeFault(
      'cli-capability-unsupported',
      'launch',
      sourceCli,
    );
  }
}
