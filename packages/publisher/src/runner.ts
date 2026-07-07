import { spawnSync } from 'node:child_process';

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
