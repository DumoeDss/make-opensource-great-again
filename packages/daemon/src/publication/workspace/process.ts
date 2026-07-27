import { spawn } from 'node:child_process';

export interface ProcessRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(program: string, args: readonly string[], options?: ProcessRunOptions): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  readonly kind: 'unavailable' | 'failed' | 'timeout' | 'output_limit';

  constructor(kind: ProcessExecutionError['kind']) {
    super('External command failed.');
    this.name = 'ProcessExecutionError';
    this.kind = kind;
  }
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(
    program: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const child = spawn(program, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;

      const fail = (kind: ProcessExecutionError['kind']): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new ProcessExecutionError(kind));
      };
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > limit) {
          fail('output_limit');
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.on('error', () => {
        clearTimeout(timer);
        fail('unavailable');
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }
}

export interface RecordedProcessCall {
  program: string;
  args: string[];
  options: ProcessRunOptions;
}

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: RecordedProcessCall[] = [];
  readonly results: Array<ProcessResult | ProcessExecutionError> = [];

  enqueue(result: ProcessResult | ProcessExecutionError): void {
    this.results.push(result);
  }

  async run(
    program: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({
      program,
      args: [...args],
      options: { ...options, env: options.env ? { ...options.env } : undefined },
    });
    const result = this.results.shift();
    if (!result) return { code: 0, stdout: '', stderr: '' };
    if (result instanceof ProcessExecutionError) throw result;
    return result;
  }
}
