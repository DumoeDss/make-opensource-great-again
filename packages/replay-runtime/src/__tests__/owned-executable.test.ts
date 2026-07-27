// STD-M1 adversarial test: proves the atomic exec binding via the runtime-owned
// immutable copy + synchronous pre-spawn identity re-check.
//
// Case 1 — "refuses launch when the spawned path is swapped after the identity
// comparison": the supervisor exposes a `preSpawnHook` test seam that fires
// AFTER verifyOwnedExecutable and BEFORE host.spawn. The test injects a hook
// that rewrites the owned copy's bytes in that gap. The post-hook re-verify
// detects the mismatch and refuses the launch (cli-capability-unsupported,
// stage launch) with zero spawns of the swapped binary.
//
// Case 2 — "swapping the ORIGINAL resolved path after staging has no effect":
// the supervisor spawns the owned COPY, not the original. After staging, the
// original is irrelevant; rewriting it must not affect the launch.
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { captureExecutableIdentity } from '../adapters/capabilityProbe.js';
import { normalizeRuntimeOptions } from '../config.js';
import { stageOwnedExecutable, type OwnedExecutable } from '../ownedExecutable.js';
import {
  superviseReplayProcess,
  type ProcessPlatformHost,
} from '../processSupervisor.js';
import { createFakeProcessTreeBoundary } from './fakeProcessTreeBoundary.js';

const stdin = new TextEncoder().encode('terminal-input-canary');
const fixtureDirectories: string[] = [];

class FakeChild extends EventEmitter {
  readonly pid = 7272;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinChunks: Buffer[] = [];
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.stdinChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  kill = vi.fn(() => true);
}

interface OwnedFixture {
  owned: OwnedExecutable;
  originalNodeCopy: string;
}

/**
 * Each call stages a FRESH owned executable — no cross-test caching, because
 * the swap-detection test (case 1) mutates the owned copy's bytes, which would
 * contaminate any cached fixture reused by the stable-copy test (case 2).
 */
async function ownedFixtureWithOriginal(): Promise<OwnedFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-exec-test-'));
  fixtureDirectories.push(dir);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const nodeCopy = path.join(dir, `node${ext}`);
  // captureExecutableIdentity rejects the system node install when its realpath
  // does not resolve back (version-manager shims, junctions). A plain copy in a
  // temp dir is a stable regular file.
  await copyFile(process.execPath, nodeCopy);
  if (process.platform !== 'win32') await chmod(nodeCopy, 0o755);
  const identity = await captureExecutableIdentity(nodeCopy, 'claude-code');
  const owned = await stageOwnedExecutable(
    nodeCopy,
    dir,
    identity,
    'claude-code',
  );
  return { owned, originalNodeCopy: nodeCopy };
}

function planFor(owned: OwnedExecutable) {
  return {
    executable: owned,
    argv: ['--resume', 'session-1'],
    cwd: path.resolve('replay-root', 'workspace'),
    environment: { HOME: path.resolve('replay-root', 'home') },
  };
}

afterAll(async () => {
  for (const dir of fixtureDirectories) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('owned executable atomic binding (STD-M1)', () => {
  it('refuses launch when the owned copy is swapped after the identity comparison', async () => {
    const { owned } = await ownedFixtureWithOriginal();

    // The supervisor calls verifyOwnedExecutable, then preSpawnHook, then
    // verifyOwnedExecutable AGAIN. The hook rewrites the owned copy's bytes in
    // the gap — the post-hook re-check must detect the mismatch.
    const preSpawnHook = async () => {
      // Strip the read-only bit (stageOwnedExecutable chmod'd to 0o500) so the
      // byte-swap write succeeds. On win32 Node's chmod toggles the read-only
      // attribute; on POSIX it changes the mode.
      await chmod(owned.runtimePath, 0o700);
      await writeFile(owned.runtimePath, 'SWAPPED-CONTENT-BY-ATTACKER');
    };

    const spawnCalls = vi.fn();
    const host: ProcessPlatformHost = { spawn: spawnCalls };
    const boundary = createFakeProcessTreeBoundary();
    const factory = { async create() { return boundary; } };

    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [],
        normalizeRuntimeOptions({}),
        'claude-code',
        '2.1.9',
        host,
        factory,
        preSpawnHook,
      ),
    ).rejects.toMatchObject({
      code: 'cli-capability-unsupported',
      stage: 'launch',
    });
    // The swapped binary was never spawned.
    expect(spawnCalls).not.toHaveBeenCalled();
  });

  it('proceeds when the ORIGINAL resolved path is swapped after staging (spawn uses the owned copy)', async () => {
    const { owned, originalNodeCopy } = await ownedFixtureWithOriginal();

    // Swap the ORIGINAL resolved path after staging. The supervisor never
    // touches this path again — it spawns the owned copy exclusively.
    await chmod(originalNodeCopy, 0o700);
    await writeFile(originalNodeCopy, 'ORIGINAL-SWAPPED-AFTER-STAGING');

    // A successful spawn requires the fake boundary to report not-alive after
    // close, matching a clean tree exit.
    const child = new FakeChild();
    const boundary = createFakeProcessTreeBoundary();
    child.on('close', () => boundary.onDirectChildClose());
    const spawnCalls = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const host: ProcessPlatformHost = { spawn: spawnCalls };
    const factory = { async create() { return boundary; } };

    const result = await superviseReplayProcess(
      planFor(owned),
      stdin,
      1_000,
      [],
      normalizeRuntimeOptions({}),
      'claude-code',
      '2.1.9',
      host,
      factory,
      // No preSpawnHook: only one verify on the owned copy, which is unchanged.
    );
    expect(result.exitStatus).toBe(0);
    expect(spawnCalls).toHaveBeenCalledTimes(1);
    // Spawn targeted the owned COPY, not the original.
    expect(spawnCalls.mock.calls[0]![0]).toBe(owned.runtimePath);
    expect(spawnCalls.mock.calls[0]![0]).not.toBe(originalNodeCopy);
  });
});
