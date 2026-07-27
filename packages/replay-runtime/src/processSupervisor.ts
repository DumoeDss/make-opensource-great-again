import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import path from 'node:path';

import type { SourceCli } from '@mosga/contracts';

import type { ProbeCommand } from './adapters/types.js';
import type { RuntimeConfig } from './config.js';
import { RuntimeFault } from './errors.js';
import {
  verifyOwnedExecutable,
  type OwnedExecutable,
} from './ownedExecutable.js';
import {
  createProcessTreeBoundaryFactory,
  type ProcessTreeBoundary,
  type ProcessTreeBoundaryFactory,
} from './processTreeBoundary.js';

/**
 * Platform host seam. Tree-termination and tree-liveness responsibilities have
 * moved to {@link ProcessTreeBoundary}; the host only spawns. Keeping the spawn
 * path on child_process.spawn preserves the existing stdio/pipe handling so
 * terminal-bytes-over-stdin keeps working unchanged.
 */
export interface ProcessPlatformHost {
  spawn(
    executable: string,
    argv: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams;
}

export const defaultProcessPlatformHost: ProcessPlatformHost = Object.freeze({
  spawn(
    executable: string,
    argv: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) {
    return spawn(executable, [...argv], {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  },
});

export interface SupervisedProcessResult {
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly exitStatus: 0;
}

export interface SupervisedProbeResult {
  readonly output: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

function fault(
  code:
    | 'cancelled'
    | 'timed-out'
    | 'cleanup-failed'
    | 'process-spawn-failed'
    | 'process-exit-failed'
    | 'process-output-limit'
    | 'cli-probe-failed'
    | 'runtime-policy-unsupported',
  stage: 'launch' | 'run' | 'terminate',
  sourceCli: SourceCli,
  replayCliVersion: string,
): RuntimeFault {
  return new RuntimeFault(code, stage, sourceCli, replayCliVersion);
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

/**
 * Supervise one replay execution through a persistent OS process-tree boundary.
 *
 * Lifecycle:
 *   1. Create the boundary (fail-closed if the platform cannot provide one).
 *   2. verifyOwnedExecutable — re-capture the owned copy's identity.
 *   3. preSpawnHook (test seam for the STD-M1 check/use gap).
 *   4. host.spawn the OWNED COPY (never the original resolved path).
 *   5. boundary.assignChild IMMEDIATELY — before awaiting any child output.
 *      Option-A assignment: there is a sub-ms window between spawn and assign
 *      in which a child could theoretically fork a breakaway descendant. For
 *      the Claude/Codex CLI resume use case this is not a realistic race: the
 *      CLI does not fork-and-escape in its first microseconds, and the Job
 *      deliberately omits JOB_OBJECT_LIMIT_BREAKAWAY_OK so later breakaway
 *      attempts are denied by the kernel.
 *   6. Drain stdout/stderr against byte caps; deliver exact stdin once.
 *   7. On deadline / output-limit / abort / direct-child-close-with-survivors:
 *      request termination through the boundary (graceful then forced), wait
 *      for the boundary to report empty, then settle.
 *   8. dispose the boundary in finally (KILL_ON_JOB_CLOSE reaps any straggler
 *      on win32; the POSIX group signal has already been delivered).
 */
export async function superviseReplayProcess(
  plan: {
    readonly executable: OwnedExecutable;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  },
  stdinBytes: Uint8Array,
  timeoutMs: number,
  signals: readonly AbortSignal[],
  config: RuntimeConfig,
  sourceCli: SourceCli,
  replayCliVersion: string,
  host: ProcessPlatformHost = defaultProcessPlatformHost,
  boundaryFactory: ProcessTreeBoundaryFactory = createProcessTreeBoundaryFactory(),
  preSpawnHook?: () => void | Promise<void>,
): Promise<SupervisedProcessResult> {
  if (signals.some((signal) => signal.aborted)) {
    throw fault('cancelled', 'terminate', sourceCli, replayCliVersion);
  }
  if (
    !path.isAbsolute(plan.executable.runtimePath) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > config.limits.executionTimeoutMs
  ) {
    throw fault('runtime-policy-unsupported', 'launch', sourceCli, replayCliVersion);
  }

  // Create the boundary BEFORE spawn: if the platform cannot provide one, fail
  // closed without spawning an unbounded tree.
  const boundary = await boundaryFactory.create();
  try {
    return await runSupervisedExecution(
      plan,
      stdinBytes,
      timeoutMs,
      signals,
      config,
      sourceCli,
      replayCliVersion,
      host,
      boundary,
      preSpawnHook,
    );
  } finally {
    boundary.dispose();
  }
}

async function runSupervisedExecution(
  plan: {
    readonly executable: OwnedExecutable;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  },
  stdinBytes: Uint8Array,
  timeoutMs: number,
  signals: readonly AbortSignal[],
  config: RuntimeConfig,
  sourceCli: SourceCli,
  replayCliVersion: string,
  host: ProcessPlatformHost,
  boundary: ProcessTreeBoundary,
  preSpawnHook: (() => void | Promise<void>) | undefined,
): Promise<SupervisedProcessResult> {
  // Atomic check/use gate: verify the owned copy's identity, then (test seam)
  // invoke preSpawnHook, THEN re-verify, THEN spawn. The STD-M1 adversarial
  // test injects a preSpawnHook that swaps the copy's bytes in the gap between
  // the two verifies; the post-hook re-check refuses the launch.
  await verifyOwnedExecutable(plan.executable, sourceCli);
  if (preSpawnHook !== undefined) {
    await preSpawnHook();
    await verifyOwnedExecutable(plan.executable, sourceCli);
  }

  return await new Promise<SupervisedProcessResult>((resolve, reject) => {
    const startedAtMs = Date.now();
    let child: ChildProcessWithoutNullStreams;

    let settled = false;
    let terminalCause: RuntimeFault | null = null;
    let terminationStarted = false;
    let childClosed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let combinedBytes = 0;
    let deadline: NodeJS.Timeout | undefined;
    let closeWaitResolve: (() => void) | undefined;
    const closeWait = new Promise<void>((resolveClose) => {
      closeWaitResolve = resolveClose;
    });

    const waitForTreeExit = async (maximumMs: number): Promise<boolean> => {
      const stopAt = Date.now() + maximumMs;
      while (true) {
        try {
          if (!(await boundary.isTreeAlive())) return true;
        } catch {
          // An unknown tree state is not safe evidence of termination.
        }
        const remaining = stopAt - Date.now();
        if (remaining <= 0) return false;
        await delay(Math.min(10, remaining));
      }
    };
    const waitForChildClose = async (maximumMs: number): Promise<boolean> => {
      if (childClosed) return true;
      await Promise.race([closeWait, delay(maximumMs)]);
      return childClosed;
    };
    const removeListeners = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const settleFailure = (f: RuntimeFault): void => {
      if (settled) return;
      settled = true;
      removeListeners();
      reject(f);
    };
    const settleSuccess = (): void => {
      if (settled) return;
      settled = true;
      const completedAtMs = Date.now();
      removeListeners();
      resolve(
        Object.freeze({
          startedAtMs,
          completedAtMs,
          exitStatus: 0 as const,
        }),
      );
    };
    const incompleteTerminationFault = (): RuntimeFault =>
      fault('cleanup-failed', 'terminate', sourceCli, replayCliVersion);
    const runTermination = async (): Promise<void> => {
      const cause = terminalCause;
      if (cause === null) {
        settleFailure(incompleteTerminationFault());
        return;
      }

      let successfulTerminationRequest = false;
      let terminationRequestFailed = false;
      try {
        await boundary.terminateTree(false);
        successfulTerminationRequest = true;
      } catch {
        terminationRequestFailed = true;
      }
      let treeExited = await waitForTreeExit(config.limits.terminationGraceMs);
      if (!treeExited) {
        try {
          await boundary.terminateTree(true);
          successfulTerminationRequest = true;
        } catch {
          terminationRequestFailed = true;
        }
        treeExited = await waitForTreeExit(config.limits.terminationGraceMs);
      }
      const closeObserved = await waitForChildClose(
        config.limits.terminationGraceMs,
      );
      if (
        !treeExited ||
        !closeObserved ||
        (terminationRequestFailed && !successfulTerminationRequest)
      ) {
        settleFailure(incompleteTerminationFault());
        return;
      }
      settleFailure(cause);
    };
    const requestTermination = (f: RuntimeFault): void => {
      if (terminalCause !== null || settled) return;
      terminalCause = f;
      if (!terminationStarted) {
        terminationStarted = true;
        void runTermination().catch(() =>
          settleFailure(incompleteTerminationFault()),
        );
      }
    };
    const onAbort = (): void =>
      requestTermination(fault('cancelled', 'terminate', sourceCli, replayCliVersion));
    const drain = (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk.byteLength
          : Buffer.byteLength(chunk);
        if (stream === 'stdout') stdoutBytes += bytes;
        else stderrBytes += bytes;
        combinedBytes += bytes;
        if (
          stdoutBytes > config.limits.stdoutBytes ||
          stderrBytes > config.limits.stderrBytes ||
          combinedBytes > config.limits.combinedOutputBytes
        ) {
          requestTermination(
            fault('process-output-limit', 'run', sourceCli, replayCliVersion),
          );
        }
      };

    // Spawn synchronously inside the Promise so close/error events emitted on
    // the next microtask always find registered listeners.
    try {
      child = host.spawn(plan.executable.runtimePath, plan.argv, {
        cwd: plan.cwd,
        env: { ...plan.environment },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch {
      reject(fault('process-spawn-failed', 'launch', sourceCli, replayCliVersion));
      return;
    }

    child.stdout.on('data', drain('stdout'));
    child.stderr.on('data', drain('stderr'));
    child.stdin.once('error', () => {
      // Close/nonzero classification remains disclosure-safe.
    });
    child.once('error', () => {
      if (terminalCause !== null) return;
      const f = fault('process-spawn-failed', 'launch', sourceCli, replayCliVersion);
      if (child.pid === undefined) settleFailure(f);
      else requestTermination(f);
    });
    child.once('close', (code) => {
      childClosed = true;
      closeWaitResolve?.();
      closeWaitResolve = undefined;
      if (settled || terminalCause !== null) return;
      void (async () => {
        let treeAlive = false;
        try {
          treeAlive = await boundary.isTreeAlive();
        } catch {
          treeAlive = true;
        }
        if (treeAlive) {
          // The direct child just closed; the OS boundary may transiently
          // still list the just-exited process. Give the kernel a brief grace
          // and re-query before concluding a detached descendant survived.
          await delay(Math.min(25, config.limits.terminationGraceMs));
          try {
            treeAlive = await boundary.isTreeAlive();
          } catch {
            treeAlive = true;
          }
        }
        if (settled || terminalCause !== null) return;
        if (treeAlive) {
          // A tree that outlives a zero-exit direct parent is not a clean
          // success — the boundary still holds a detached descendant.
          requestTermination(
            fault('process-exit-failed', 'run', sourceCli, replayCliVersion),
          );
        } else if (code === 0) {
          settleSuccess();
        } else {
          settleFailure(
            fault('process-exit-failed', 'run', sourceCli, replayCliVersion),
          );
        }
      })();
    });
    // Assign the just-spawned child to the boundary. Fired (not awaited) after
    // listener registration and before stdin delivery: assignment is in flight
    // before the CLI can read stdin and spawn helpers, which closes the
    // assignment-window race. Any failure kills the child (fail closed) and the
    // close handler settles.
    void boundary
      .assignChild({ pid: child.pid! })
      .catch(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Best-effort; the assignment failure surfaces via the close handler.
        }
      });
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    deadline = setTimeout(
      () =>
        requestTermination(
          fault('timed-out', 'terminate', sourceCli, replayCliVersion),
        ),
      timeoutMs,
    );
    deadline.unref();

    if (signals.some((signal) => signal.aborted)) {
      onAbort();
    }
    if (terminalCause === null) {
      child.stdin.end(Buffer.from(stdinBytes));
    }
  });
}

/**
 * Probe mode of the tree-owned supervisor (closes SPEC-M1). Creates its OWN
 * boundary per probe command, spawns the owned probe executable already-bound,
 * captures combined output up to probeOutputBytes, sends NO stdin, applies
 * probeTimeoutMs, and on timeout/overflow/abort terminates the whole tree
 * through the boundary and settles cli-probe-failed.
 */
export async function superviseProbeProcess(
  executable: OwnedExecutable,
  command: ProbeCommand,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  config: RuntimeConfig,
  sourceCli: SourceCli,
  signals: readonly AbortSignal[],
  host: ProcessPlatformHost = defaultProcessPlatformHost,
  boundaryFactory: ProcessTreeBoundaryFactory = createProcessTreeBoundaryFactory(),
): Promise<SupervisedProbeResult> {
  if (signals.some((signal) => signal.aborted)) {
    throw new RuntimeFault('cancelled', 'probe', sourceCli);
  }
  const boundary = await boundaryFactory.create();
  try {
    await verifyOwnedExecutable(executable, sourceCli);
    return await new Promise<SupervisedProbeResult>((resolve, reject) => {
      const startedAtMs = Date.now();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = host.spawn(executable.runtimePath, [...command.argv], {
          cwd,
          env: { ...environment },
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } catch {
        reject(new RuntimeFault('cli-probe-failed', 'probe', sourceCli));
        return;
      }
      // Probes send NO stdin: end the pipe immediately so the probe child sees
      // EOF (the host forces ['pipe','pipe','pipe']).
      try {
        child.stdin.end();
      } catch {
        // best-effort
      }
      void boundary
        .assignChild({ pid: child.pid! })
        .catch(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // best-effort
          }
        });

      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      let deadline: NodeJS.Timeout | undefined;
      let pendingFault: RuntimeFault | null = null;
      let childClosed = false;

      const finish = (
        error: RuntimeFault | null,
        output = '',
      ): void => {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        for (const signal of signals) {
          signal.removeEventListener('abort', onAbort);
        }
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();
        child.removeAllListeners();
        const completedAtMs = Date.now();
        void (async () => {
          if (error !== null) {
            // Force-terminate the whole tree through the boundary, then wait
            // (bounded) for it to report empty before settling.
            try {
              await boundary.terminateTree(true);
            } catch {
              // best-effort
            }
            const stopAt = Date.now() + config.limits.terminationGraceMs;
            while (Date.now() < stopAt) {
              try {
                if (!(await boundary.isTreeAlive())) break;
              } catch {
                break;
              }
              await delay(10);
            }
          }
          if (error === null) {
            resolve(Object.freeze({ output, startedAtMs, completedAtMs }));
          } else reject(error);
        })();
      };
      const terminate = (f: RuntimeFault): void => {
        if (settled || pendingFault !== null) return;
        pendingFault = f;
        // Wait for the child to close (the boundary termination will reap it),
        // bounded by a grace window.
        const stopAt = Date.now() + config.limits.terminationGraceMs;
        const check = () => {
          if (childClosed || Date.now() >= stopAt) {
            finish(f);
          } else {
            setTimeout(check, 10);
          }
        };
        void boundary
          .terminateTree(true)
          .catch(() => finish(f));
        check();
      };
      const onAbort = (): void =>
        terminate(new RuntimeFault('cancelled', 'probe', sourceCli));
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > config.limits.probeOutputBytes) {
          terminate(new RuntimeFault('cli-probe-failed', 'probe', sourceCli));
          return;
        }
        chunks.push(buffer);
      };

      child.once('error', () =>
        finish(new RuntimeFault('cli-probe-failed', 'probe', sourceCli)),
      );
      child.once('close', (code) => {
        childClosed = true;
        if (pendingFault !== null) {
          finish(pendingFault);
          return;
        }
        if (code !== 0) {
          finish(new RuntimeFault('cli-probe-failed', 'probe', sourceCli));
          return;
        }
        finish(null, Buffer.concat(chunks).toString('utf8'));
      });
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      for (const signal of signals) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Close the abort-during-verify race: if the signal aborted in the gap
      // between the initial pre-check (before the Promise, during
      // verifyOwnedExecutable) and listener registration (after spawn), the
      // abort event was dispatched with no listener registered to catch it.
      // Re-check signal.aborted here so the handler fires immediately.
      if (signals.some((signal) => signal.aborted)) {
        onAbort();
      }
      deadline = setTimeout(
        () => terminate(new RuntimeFault('cli-probe-failed', 'probe', sourceCli)),
        config.limits.probeTimeoutMs,
      );
      deadline.unref();
    });
  } finally {
    boundary.dispose();
  }
}
