import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { captureExecutableIdentity } from '../adapters/capabilityProbe.js';
import { normalizeRuntimeOptions } from '../config.js';
import { stageOwnedExecutable, type OwnedExecutable } from '../ownedExecutable.js';
import { createProcessTreeBoundaryFactory } from '../processTreeBoundary.js';
import {
  superviseReplayProcess,
  type ProcessPlatformHost,
} from '../processSupervisor.js';
import { createFakeProcessTreeBoundary } from './fakeProcessTreeBoundary.js';

class FakeChild extends EventEmitter {
  readonly pid = 4242;
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

const stdin = new TextEncoder().encode('terminal-input-canary');
const temporaryDirectories: string[] = [];
const fixtureDirectories: string[] = [];

let cachedOwned: OwnedExecutable | null = null;
async function ownedFixture(): Promise<OwnedExecutable> {
  if (cachedOwned !== null) return cachedOwned;
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-supervisor-test-'));
  fixtureDirectories.push(dir);
  // Copy node to a clean temp path first: captureExecutableIdentity rejects the
  // system node install when its realpath does not resolve back to the candidate
  // (version-manager shims, junctions, etc.). A plain copy in a temp dir is a
  // stable regular file.
  const ext = process.platform === 'win32' ? '.exe' : '';
  const nodeCopy = path.join(dir, `node${ext}`);
  await copyFile(process.execPath, nodeCopy);
  if (process.platform !== 'win32') await chmod(nodeCopy, 0o755);
  const identity = await captureExecutableIdentity(nodeCopy, 'claude-code');
  cachedOwned = await stageOwnedExecutable(
    nodeCopy,
    dir,
    identity,
    'claude-code',
  );
  return cachedOwned;
}

function planFor(owned: OwnedExecutable) {
  return {
    executable: owned,
    argv: ['--resume', 'session-1'],
    cwd: path.resolve('replay-root', 'workspace'),
    environment: { HOME: path.resolve('replay-root', 'home') },
  };
}

interface RigOptions {
  onSpawn?: (child: FakeChild) => void;
  preserveTreeOnClose?: boolean;
  onTerminate?: (
    boundary: ReturnType<typeof createFakeProcessTreeBoundary>,
    child: FakeChild,
    force: boolean,
  ) => void;
}

function rig(options: RigOptions = {}) {
  const child = new FakeChild();
  const boundary = createFakeProcessTreeBoundary({
    preserveTreeOnClose: options.preserveTreeOnClose ?? false,
  });
  // Wire the boundary's close semantics: when the fake child emits close, the
  // boundary reflects whether the descendant tree survived. Registered before
  // the supervisor registers its own close listener, so it runs first.
  child.on('close', () => boundary.onDirectChildClose());
  const spawnCalls = vi.fn(() => {
    options.onSpawn?.(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const host: ProcessPlatformHost = { spawn: spawnCalls };
  const factory = {
    async create() {
      return boundary;
    },
  };
  // The fake's terminateTree only records; the test's onTerminate simulates
  // the effect (child close / alive flip) so escalation stays controllable.
  const originalTerminate = boundary.terminateTree.bind(boundary);
  boundary.terminateTree = async (force: boolean) => {
    await originalTerminate(force);
    options.onTerminate?.(boundary, child, force);
  };
  return { child, boundary, host, factory, spawnCalls };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  cachedOwned = null;
  for (const directory of fixtureDirectories) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});

describe('controlled process lifecycle', () => {
  it('spawns once with shell false, drains output, and sends exact stdin once', async () => {
    const owned = await ownedFixture();
    const { child, host, factory, spawnCalls } = rig({
      onSpawn: (c) => {
        queueMicrotask(() => {
          c.stdout.write('discarded output');
          c.stderr.write('discarded error');
          c.emit('close', 0, null);
        });
      },
    });
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
    );
    expect(result.exitStatus).toBe(0);
    expect(spawnCalls).toHaveBeenCalledTimes(1);
    expect(spawnCalls.mock.calls[0]![0]).toBe(owned.runtimePath);
    expect(spawnCalls.mock.calls[0]![2]).toMatchObject({
      shell: false,
      windowsHide: true,
      cwd: planFor(owned).cwd,
      env: planFor(owned).environment,
    });
    expect(Buffer.concat(child.stdinChunks)).toEqual(Buffer.from(stdin));
    expect(JSON.stringify(result)).not.toContain('discarded');
  });

  it('maps synchronous spawn refusal without raw cause data', async () => {
    const owned = await ownedFixture();
    const host: ProcessPlatformHost = {
      spawn() {
        throw new Error('credential/path/body canary');
      },
    };
    const factory = { async create() { return createFakeProcessTreeBoundary(); } };
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
      ),
    ).rejects.toMatchObject({
      code: 'process-spawn-failed',
      stage: 'launch',
    });
  });

  it('discards canary stderr and classifies nonzero exit', async () => {
    const owned = await ownedFixture();
    const { host, factory } = rig({
      onSpawn: (c) => {
        queueMicrotask(() => {
          c.stderr.write('prompt token native-body absolute-path');
          c.emit('close', 7, null);
        });
      },
    });
    let failure: unknown;
    try {
      await superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [],
        normalizeRuntimeOptions({}),
        'codex',
        '0.101.8',
        host,
        factory,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'process-exit-failed',
      stage: 'run',
    });
    expect(JSON.stringify(failure)).not.toContain('native-body');
  });

  it('terminates the tree on output overflow and returns no output', async () => {
    const owned = await ownedFixture();
    const { boundary, host, factory } = rig({
      onSpawn: (c) => {
        queueMicrotask(() => c.stdout.write('x'.repeat(128)));
      },
      onTerminate: (b, c, _force) => {
        // Termination reaps the tree and closes the child.
        b.alive = false;
        queueMicrotask(() => c.emit('close', null, 'SIGTERM'));
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [],
        normalizeRuntimeOptions({
          limits: {
            stdoutBytes: 64,
            stderrBytes: 64,
            combinedOutputBytes: 64,
          },
        }),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({
      code: 'process-output-limit',
      stage: 'run',
    });
    expect(boundary.terminateCalls).toContain(false);
  });

  it('does not call the platform host for a pre-aborted signal', async () => {
    const owned = await ownedFixture();
    const abort = new AbortController();
    abort.abort();
    const { host, factory, spawnCalls } = rig();
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [abort.signal],
        normalizeRuntimeOptions({}),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(spawnCalls).not.toHaveBeenCalled();
  });

  it('uses a first-wins cancel latch and graceful tree termination', async () => {
    const owned = await ownedFixture();
    const abort = new AbortController();
    const { boundary, host, factory } = rig({
      onSpawn: () => queueMicrotask(() => abort.abort()),
      onTerminate: (b, c, _force) => {
        b.alive = false;
        queueMicrotask(() => c.emit('close', null, 'SIGTERM'));
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        20,
        [abort.signal],
        normalizeRuntimeOptions({}),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({ code: 'cancelled', stage: 'terminate' });
    expect(boundary.terminateCalls).toHaveLength(1);
    expect(boundary.terminateCalls[0]).toBe(false);
  });

  it('closes the abort-during-spawn race before stdin delivery', async () => {
    const owned = await ownedFixture();
    const abort = new AbortController();
    const { boundary, child, host, factory } = rig({
      onSpawn: () => abort.abort(),
      onTerminate: (b, c, _force) => {
        b.alive = false;
        queueMicrotask(() => c.emit('close', null, 'SIGTERM'));
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [abort.signal],
        normalizeRuntimeOptions({}),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(child.stdinChunks).toHaveLength(0);
    expect(boundary.terminateCalls[0]).toBe(false);
  });

  it('keeps force escalation after direct-parent close while a descendant is alive', async () => {
    const owned = await ownedFixture();
    const abort = new AbortController();
    const { boundary, host, factory } = rig({
      preserveTreeOnClose: true,
      onSpawn: () => queueMicrotask(() => abort.abort()),
      onTerminate: (b, c, force) => {
        if (!force) {
          // Graceful closes the direct child but the descendant survives.
          queueMicrotask(() => c.emit('close', null, 'SIGTERM'));
          b.alive = true;
        } else {
          // Force reaps the descendant.
          b.alive = false;
        }
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [abort.signal],
        normalizeRuntimeOptions({
          limits: { terminationGraceMs: 20 },
        }),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(boundary.terminateCalls).toEqual([false, true]);
    expect(boundary.alive).toBe(false);
  });

  it('bounds and surfaces an unconfirmed force-termination failure', async () => {
    const owned = await ownedFixture();
    const abort = new AbortController();
    const { boundary, host, factory } = rig({
      onSpawn: () => queueMicrotask(() => abort.abort()),
      onTerminate: (b, _c, _force) => {
        // Neither graceful nor force reaps the tree.
        b.alive = true;
      },
    });
    const started = Date.now();
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [abort.signal],
        normalizeRuntimeOptions({
          limits: { terminationGraceMs: 20 },
        }),
        'codex',
        '0.101.8',
        host,
        factory,
      ),
    ).rejects.toMatchObject({
      code: 'cleanup-failed',
      stage: 'terminate',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(boundary.terminateCalls).toEqual([false, true]);
  });

  it('terminates a live descendant after a zero-exit direct parent', async () => {
    const owned = await ownedFixture();
    const { boundary, host, factory } = rig({
      preserveTreeOnClose: true,
      onSpawn: (c) =>
        queueMicrotask(() => {
          c.emit('close', 0, null);
        }),
      onTerminate: (b, _c, force) => {
        if (force) b.alive = false;
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        1_000,
        [],
        normalizeRuntimeOptions({
          limits: { terminationGraceMs: 20 },
        }),
        'claude-code',
        '2.1.9',
        host,
        factory,
      ),
    ).rejects.toMatchObject({
      code: 'process-exit-failed',
      stage: 'run',
    });
    expect(boundary.terminateCalls).toEqual([false, true]);
  });

  it('classifies deadline and escalates to forced descendant termination', async () => {
    const owned = await ownedFixture();
    const { boundary, host, factory } = rig({
      onSpawn: () => {},
      onTerminate: (b, c, force) => {
        if (force) {
          queueMicrotask(() => c.emit('close', null, 'SIGKILL'));
          b.alive = false;
        }
      },
    });
    await expect(
      superviseReplayProcess(
        planFor(owned),
        stdin,
        20,
        [],
        normalizeRuntimeOptions({
          limits: { terminationGraceMs: 20 },
        }),
        'codex',
        '0.101.8',
        host,
        factory,
      ),
    ).rejects.toMatchObject({ code: 'timed-out', stage: 'terminate' });
    expect(boundary.terminateCalls).toEqual([false, true]);
  });

  it('kills a real hermetic Node process tree on the current platform', async () => {
    // Real boundary + real host. The descendant is spawned DETACHED so it
    // escapes libuv's kill-on-close cleanup — this is the real SPEC-B1 threat.
    // The boundary must retain and reap it. Bounded by terminationGraceMs and a
    // finally that SIGKILLs every recorded PID on every pass/fail path.
    const owned = await ownedFixture();
    const directory = await mkdtemp(
      path.join(tmpdir(), 'mosga-process-tree-test-'),
    );
    temporaryDirectories.push(directory);
    const script = path.join(directory, 'parent.cjs');
    const pidFile = path.join(directory, 'descendant.pid');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        // Detached + unref: survives the parent's own libuv cleanup, so only
        // the Job/process-group boundary can reap it.
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
        "child.unref();",
        'writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    const environment: Record<string, string> = {
      HOME: directory,
      USERPROFILE: directory,
    };
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot !== undefined) {
      environment.SystemRoot = systemRoot;
      environment.WINDIR = systemRoot;
    }
    const deadline = Date.now() + 30_000;
    let treePids: number[] = [];
    try {
      await expect(
        superviseReplayProcess(
          {
            executable: owned,
            argv: [script, pidFile],
            cwd: directory,
            environment,
          },
          new Uint8Array(),
          200,
          [],
          normalizeRuntimeOptions({
            limits: { terminationGraceMs: 1_500 },
          }),
          'codex',
          '0.101.8',
          undefined,
          createProcessTreeBoundaryFactory(),
        ),
      ).rejects.toMatchObject({ code: 'timed-out' });
      expect(Date.now()).toBeLessThan(deadline);
      treePids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
      expect(treePids).toHaveLength(2);
      expect(treePids.every(Number.isSafeInteger)).toBe(true);
      // The detached descendant MUST be dead — the boundary reaped it.
      await vi.waitFor(
        () => {
          expect(() => process.kill(treePids[1]!, 0)).toThrow();
        },
        { timeout: 3_000, interval: 50 },
      );
    } finally {
      if (treePids.length === 0) {
        treePids = await readFile(pidFile, 'utf8')
          .then((value) => JSON.parse(value) as number[])
          .catch(() => []);
      }
      for (const pid of treePids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // The expected path already terminated the complete tree.
        }
      }
    }
  });
});
