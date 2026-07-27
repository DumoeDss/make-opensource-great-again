// SPEC-B1 adversarial test: proves the persistent OS process-tree boundary
// retains and reaps a detached descendant that survives its parent's zero exit.
//
// On win32 this is the Windows Job Object path (koffi FFI). The direct-parent
// PID goes stale the instant the parent exits; the Job Object is the persistent
// identity that survives. A detached descendant spawned by the parent inherits
// the Job, so `isTreeAlive()` reports alive after the parent's zero exit, and
// `terminateTree(true)` reaps it.
//
// REAL-PROCESS-TREE TEST DISCIPLINE (load-bearing — prior rounds failed here):
// every test records every PID it spawns and, in a `finally`, disposes the
// boundary AND force-kills every recorded PID on EVERY path (pass OR fail),
// with a hard cap. Temp dir removal comes AFTER the descendant is confirmed
// dead, so there is no EBUSY.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createProcessTreeBoundaryFactory } from '../processTreeBoundary.js';

const directories: string[] = [];

afterAll(async () => {
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Force-kill a PID on every platform. On win32 `process.kill(pid, 'SIGKILL')`
 * calls TerminateProcess; on POSIX it sends SIGKILL. Wrapped in try/catch —
 * never let cleanup throw mask the real assertion.
 */
function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead or inaccessible — the expected path.
  }
}

/**
 * Confirm a PID is no longer alive. Returns true if `process.kill(pid, 0)`
 * throws (ESRCH/EPERM on POSIX, error on win32).
 */
function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe('process tree boundary (SPEC-B1)', () => {
  it.skipIf(process.platform !== 'win32')(
    'kills a real hermetic zero-exit-detached-descendant tree via the Job Object',
    async () => {
      const factory = createProcessTreeBoundaryFactory();
      const boundary = await factory.create();
      const directory = await mkdtemp(
        path.join(tmpdir(), 'mosga-tree-boundary-test-'),
      );
      directories.push(directory);
      const script = path.join(directory, 'parent.cjs');
      const pidFile = path.join(directory, 'pids.json');
      // The parent script waits long enough for the test to assign it to the
      // Job, THEN spawns a detached descendant. The descendant inherits the Job
      // (JOB_OBJECT_LIMIT_BREAKAWAY_OK is deliberately NOT set, so the kernel
      // denies CREATE_BREAKAWAY_FROM_JOB). The parent then exits 0.
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          'setTimeout(() => {',
          '  const child = spawn(process.execPath,',
          "    ['-e', 'setInterval(() => {}, 1000)'],",
          "    { stdio: 'ignore', detached: true });",
          '  child.unref();',
          "  writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));",
          "  setTimeout(() => process.exit(0), 100);",
          '}, 150);',
          '',
        ].join('\n'),
      );

      const parent = spawn(process.execPath, [script, pidFile], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const parentPid = parent.pid!;
      const recordedPids: number[] = [parentPid];
      let descendantPid: number | null = null;

      try {
        // Assign the parent to the Job BEFORE it spawns the descendant.
        await boundary.assignChild({ pid: parentPid });

        // Wait for the parent to exit zero (writes the PID file first).
        await new Promise<void>((resolve) => {
          parent.once('close', () => resolve());
        });

        const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
        expect(pids).toHaveLength(2);
        descendantPid = pids[1]!;
        recordedPids.push(descendantPid);

        // The core SPEC-B1 assertion: after the parent's zero exit, the
        // boundary STILL reports the tree alive — the descendant is in the Job.
        // Poll because the kernel may transiently list the just-exited parent.
        await vi.waitFor(
          async () => {
            expect(await boundary.isTreeAlive()).toBe(true);
          },
          { timeout: 2_000, interval: 25 },
        );

        // Terminate the whole tree through the boundary.
        await boundary.terminateTree(true);

        // The boundary must report empty within a bounded grace.
        await vi.waitFor(
          async () => {
            expect(await boundary.isTreeAlive()).toBe(false);
          },
          { timeout: 3_000, interval: 25 },
        );

        // The detached descendant MUST be dead — the boundary reaped it.
        expect(descendantPid).not.toBeNull();
        await vi.waitFor(
          () => {
            expect(pidIsDead(descendantPid!)).toBe(true);
          },
          { timeout: 3_000, interval: 25 },
        );
      } finally {
        // Every terminal path: dispose the boundary (KILL_ON_JOB_CLOSE reaps
        // stragglers), force-kill every recorded PID, then clean the temp dir.
        boundary.dispose();
        for (const pid of recordedPids) {
          forceKill(pid);
        }
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  it('terminates a real process through the boundary on the current platform', async () => {
    // Cross-platform smoke: spawn a real hanging node process, assign it to the
    // boundary, terminate via the boundary, and confirm it is dead. On win32
    // this exercises the Job Object kill; on POSIX the process-group signal.
    const factory = createProcessTreeBoundaryFactory();
    const boundary = await factory.create();
    const detached = process.platform !== 'win32';
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore', detached, windowsHide: true },
    );
    const pid = child.pid!;
    try {
      await boundary.assignChild({ pid });
      // Confirm the boundary sees the live tree.
      await vi.waitFor(
        async () => {
          expect(await boundary.isTreeAlive()).toBe(true);
        },
        { timeout: 2_000, interval: 25 },
      );
      await boundary.terminateTree(true);
      await vi.waitFor(
        async () => {
          expect(await boundary.isTreeAlive()).toBe(false);
        },
        { timeout: 3_000, interval: 25 },
      );
      await vi.waitFor(
        () => {
          expect(pidIsDead(pid)).toBe(true);
        },
        { timeout: 3_000, interval: 25 },
      );
    } finally {
      boundary.dispose();
      forceKill(pid);
      if (detached) {
        // On POSIX, also reap the process group as belt-and-suspenders.
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Group already empty.
        }
      }
    }
  });
});
