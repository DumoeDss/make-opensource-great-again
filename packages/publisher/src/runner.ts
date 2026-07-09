import { spawn, spawnSync } from 'node:child_process';

/** Result of running an external command. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A minimal command runner abstraction so the PR flow never hard-codes real
 * process execution: the default shells out to the binary, while tests inject a
 * fake that records commands and never touches git/gh or the network.
 */
export interface CommandRunner {
  run(command: string, args: string[], opts?: { cwd?: string; input?: string }): RunResult;
}

/** The default runner: a synchronous child process (used outside tests). */
export const defaultRunner: CommandRunner = {
  run(command, args, opts) {
    const res = spawnSync(command, args, {
      cwd: opts?.cwd,
      input: opts?.input,
      encoding: 'utf-8',
      shell: false,
    });
    if (res.error) {
      return { code: 127, stdout: '', stderr: res.error.message };
    }
    return {
      code: res.status ?? 1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  },
};

/** Is `git` available on this machine? */
export function isGitAvailable(runner: CommandRunner = defaultRunner): boolean {
  return runner.run('git', ['--version']).code === 0;
}

/** Is the `gh` CLI available (and thus a candidate for push + PR open)? */
export function isGhAvailable(runner: CommandRunner = defaultRunner): boolean {
  return runner.run('gh', ['--version']).code === 0;
}

/**
 * The asynchronous counterpart of `CommandRunner`. The daemon runs git/gh through
 * this so a subprocess never blocks its event loop; the interface is widened, the
 * commands and their behaviour are identical to the sync runner. Tests inject a
 * fake that records commands and never touches git/gh or the network.
 */
export interface AsyncCommandRunner {
  runAsync(command: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<RunResult>;
}

/** The default async runner: a non-blocking child process (`spawn`). */
export const defaultAsyncRunner: AsyncCommandRunner = {
  runAsync(command, args, opts) {
    return new Promise<RunResult>((resolve) => {
      const child = spawn(command, args, { cwd: opts?.cwd, shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      // A spawn error (e.g. ENOENT for a missing binary) mirrors the sync
      // runner's 127 mapping so availability probes read identically.
      child.on('error', (err) => {
        resolve({ code: 127, stdout: '', stderr: err.message });
      });
      child.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
      if (opts?.input !== undefined) {
        child.stdin?.write(opts.input);
      }
      child.stdin?.end();
    });
  },
};

/** Is `git` available on this machine? (async) */
export async function isGitAvailableAsync(runner: AsyncCommandRunner = defaultAsyncRunner): Promise<boolean> {
  return (await runner.runAsync('git', ['--version'])).code === 0;
}

/** Is the `gh` CLI available (and thus a candidate for push + PR open)? (async) */
export async function isGhAvailableAsync(runner: AsyncCommandRunner = defaultAsyncRunner): Promise<boolean> {
  return (await runner.runAsync('gh', ['--version'])).code === 0;
}

/**
 * Is `gh` authenticated? Probes `gh auth status` (exit 0 = logged in). A non-zero
 * exit — `gh` present but not logged in — is distinct from `gh` being absent, so
 * the caller can surface `gh_unauthenticated` rather than the gh-absent manual path.
 */
export async function ghAuthenticatedAsync(runner: AsyncCommandRunner = defaultAsyncRunner): Promise<boolean> {
  return (await runner.runAsync('gh', ['auth', 'status'])).code === 0;
}
