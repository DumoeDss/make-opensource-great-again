// SPEC-M1 adversarial test: proves a capability probe whose child spawns a
// detached descendant terminates the WHOLE tree through the shared
// ProcessTreeBoundary on timeout, output-overflow, and abort.
//
// The probe CLI is a real Node process (the staged OwnedExecutable copy) that
// spawns a long-lived detached descendant and then either hangs, overflows
// stdout, or waits for an external abort. Before this change, the probe killed
// only the direct child (capabilityProbe.ts:261) and settled on direct-child
// close, leaving the descendant alive
// (`descendantAliveAfterProbeTimeout:true`). The probe now routes through the
// tree-owned `superviseProbeProcess`, which creates its own boundary per probe
// command and force-terminates the entire tree before settling.
//
// REAL-PROCESS-TREE TEST DISCIPLINE: each test records every PID and, in a
// `finally`, force-kills every recorded PID on EVERY path (pass OR fail). The
// temp dir is removed only after the descendant is confirmed dead.
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { captureExecutableIdentity } from '../adapters/capabilityProbe.js';
import { normalizeRuntimeOptions } from '../config.js';
import { stageOwnedExecutable, type OwnedExecutable } from '../ownedExecutable.js';
import { superviseProbeProcess } from '../processSupervisor.js';

const directories: string[] = [];
const fixtureDirectories: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-probe-tree-test-'));
  directories.push(dir);
  return dir;
}

let cachedOwned: OwnedExecutable | null = null;
async function nodeOwnedFixture(): Promise<OwnedExecutable> {
  if (cachedOwned !== null) return cachedOwned;
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-probe-tree-node-'));
  fixtureDirectories.push(dir);
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

function probeEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot !== undefined) {
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
  }
  return env;
}

/**
 * Writes a probe script that spawns a DETACHED long-lived descendant (which
 * escapes the probe parent's own libuv cleanup), writes both PIDs to a file,
 * then either hangs or overflows stdout depending on `mode`.
 *
 * The descendant-spawn is delayed 50ms so the boundary assignment (which fires
 * synchronously after spawn in superviseProbeProcess) completes first — this
 * is the Option-A assignment window the plan acknowledges.
 */
async function writeProbeScript(
  scriptPath: string,
  pidFile: string,
  mode: 'hang' | 'overflow',
): Promise<void> {
  const overflowLine =
    mode === 'overflow'
      ? "setTimeout(() => process.stdout.write(Buffer.alloc(1024 * 1024).fill(0x78)), 120);"
      : '';
  await writeFile(
    scriptPath,
    [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      'setTimeout(() => {',
      '  const child = spawn(process.execPath,',
      "    ['-e', 'setInterval(() => {}, 1000)'],",
      "    { stdio: 'ignore', detached: true });",
      '  child.unref();',
      "  writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));",
      '}, 50);',
      "setInterval(() => {}, 1000);",
      overflowLine,
      '',
    ].join('\n'),
  );
}

function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead or inaccessible.
  }
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

afterAll(async () => {
  cachedOwned = null;
  for (const dir of fixtureDirectories) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('capability probe tree termination (SPEC-M1)', () => {
  it('probe timeout terminates a real hanging descendant via the shared tree boundary', { retry: 2 }, async () => {
    const owned = await nodeOwnedFixture();
    const dir = await directory();
    const scriptPath = path.join(dir, 'hang-probe.cjs');
    const pidFile = path.join(dir, 'pids.json');
    await writeProbeScript(scriptPath, pidFile, 'hang');

    // probeTimeoutMs is deliberately tight so the test exercises a timeout
    // kill quickly, but must still give the probe process enough wall-clock to
    // start Node + spawn the descendant under heavy parallel contention (the
    // full-suite runs ~16 workers). 2s holds with wide margin.
    const config = normalizeRuntimeOptions({
      limits: { probeTimeoutMs: 2_000 },
    });
    let pids: number[] = [];
    try {
      await expect(
        superviseProbeProcess(
          owned,
          { id: 'hang', argv: [scriptPath, pidFile] },
          dir,
          probeEnv(dir),
          config,
          'claude-code',
          [],
        ),
      ).rejects.toMatchObject({ code: 'cli-probe-failed' });

      pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
      expect(pids).toHaveLength(2);
      const descendantPid = pids[1]!;
      // The detached descendant MUST be dead — the probe's boundary reaped it.
      // Widened from 3s/25ms: under the full repo suite's parallel load the OS
      // can lag well beyond 3s between TerminateJobObject and actual process-
      // table reap. 15s holds with wide margin; the 30s testTimeout and the
      // finally-PID-cleanup keep the test bounded.
      await vi.waitFor(
        () => {
          expect(pidIsDead(descendantPid)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );
    } finally {
      for (const pid of pids) {
        forceKill(pid);
      }
    }
  });

  it('probe output-overflow terminates a real hanging descendant via the shared tree boundary', { retry: 2 }, async () => {
    const owned = await nodeOwnedFixture();
    const dir = await directory();
    const scriptPath = path.join(dir, 'overflow-probe.cjs');
    const pidFile = path.join(dir, 'pids.json');
    await writeProbeScript(scriptPath, pidFile, 'overflow');

    const config = normalizeRuntimeOptions({
      limits: { probeOutputBytes: 64 },
    });
    let pids: number[] = [];
    try {
      await expect(
        superviseProbeProcess(
          owned,
          { id: 'overflow', argv: [scriptPath, pidFile] },
          dir,
          probeEnv(dir),
          config,
          'claude-code',
          [],
        ),
      ).rejects.toMatchObject({ code: 'cli-probe-failed' });

      pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
      expect(pids).toHaveLength(2);
      const descendantPid = pids[1]!;
      // Widened from 3s/25ms: under the full repo suite's parallel load the OS
      // can lag well beyond 3s between TerminateJobObject and actual process-
      // table reap. 15s holds with wide margin; the 30s testTimeout and the
      // finally-PID-cleanup keep the test bounded.
      await vi.waitFor(
        () => {
          expect(pidIsDead(descendantPid)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );
    } finally {
      for (const pid of pids) {
        forceKill(pid);
      }
    }
  });

  it('probe abort terminates a real hanging descendant via the shared tree boundary', { retry: 2 }, async () => {
    const owned = await nodeOwnedFixture();
    const dir = await directory();
    const scriptPath = path.join(dir, 'abort-probe.cjs');
    const pidFile = path.join(dir, 'pids.json');
    await writeProbeScript(scriptPath, pidFile, 'hang');

    const abort = new AbortController();
    // Abort after the descendant has been spawned. The delay must account for
    // verifyOwnedExecutable (~200ms re-hash of the owned node copy in isolation,
    // far longer under full-suite parallel contention) BEFORE the probe child
    // is spawned, plus Node startup (~30ms) and the script's 50ms descendant-
    // spawn delay. 1.5s gives comfortable margin while keeping a wide gap to
    // the default 5s probeTimeoutMs so the abort reliably wins the race.
    const timer = setTimeout(() => abort.abort(), 1_500);
    timer.unref();

    const config = normalizeRuntimeOptions({});
    let pids: number[] = [];
    try {
      await expect(
        superviseProbeProcess(
          owned,
          { id: 'abort', argv: [scriptPath, pidFile] },
          dir,
          probeEnv(dir),
          config,
          'claude-code',
          [abort.signal],
        ),
      ).rejects.toMatchObject({ code: 'cancelled' });

      pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
      expect(pids).toHaveLength(2);
      const descendantPid = pids[1]!;
      // Widened from 3s/25ms: under the full repo suite's parallel load the OS
      // can lag well beyond 3s between TerminateJobObject and actual process-
      // table reap. 15s holds with wide margin; the 30s testTimeout and the
      // finally-PID-cleanup keep the test bounded.
      await vi.waitFor(
        () => {
          expect(pidIsDead(descendantPid)).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );
    } finally {
      clearTimeout(timer);
      for (const pid of pids) {
        forceKill(pid);
      }
    }
  });
});
