import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SourceCli } from '@mosga/contracts';

import type { RuntimeConfig } from '../config.js';
import { RuntimeFault } from '../errors.js';
import {
  stageOwnedExecutable,
} from '../ownedExecutable.js';
import {
  superviseProbeProcess,
} from '../processSupervisor.js';
import type {
  ProbeEvidence,
  RuntimeAdapter,
} from './types.js';

export interface ExecutableIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly digest: `sha256:${string}`;
}

function executableFault(sourceCli: SourceCli): RuntimeFault {
  return new RuntimeFault('cli-not-found', 'probe', sourceCli);
}

function identityPart(value: bigint): string {
  return value.toString(10);
}

export async function captureExecutableIdentity(
  candidate: string,
  sourceCli: SourceCli,
): Promise<ExecutableIdentity> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (!path.isAbsolute(candidate)) throw executableFault(sourceCli);
    const before = await lstat(candidate, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw executableFault(sourceCli);
    }
    const resolvedBefore = await realpath(candidate);
    if (path.resolve(resolvedBefore) !== path.resolve(candidate)) {
      throw executableFault(sourceCli);
    }
    if (process.platform !== 'win32') {
      await access(candidate, fsConstants.X_OK);
    } else if (!/\.(?:exe|com)$/i.test(candidate)) {
      throw executableFault(sourceCli);
    }

    handle = await open(
      candidate,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(candidate, { bigint: true });
    const resolvedAfter = await realpath(candidate);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      path.resolve(resolvedAfter) !== path.resolve(candidate) ||
      opened.dev === 0n ||
      opened.ino === 0n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== before.size ||
      opened.size !== after.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs ||
      opened.ctimeNs !== after.ctimeNs
    ) {
      throw executableFault(sourceCli);
    }

    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({
      autoClose: false,
    })) {
      digest.update(chunk as Buffer);
    }

    const finalPathStats = await lstat(candidate, { bigint: true });
    const finalOpenedStats = await handle.stat({ bigint: true });
    const finalResolved = await realpath(candidate);
    if (
      !finalPathStats.isFile() ||
      finalPathStats.isSymbolicLink() ||
      path.resolve(finalResolved) !== path.resolve(candidate) ||
      finalPathStats.dev !== opened.dev ||
      finalPathStats.ino !== opened.ino ||
      finalPathStats.size !== opened.size ||
      finalPathStats.mtimeNs !== opened.mtimeNs ||
      finalPathStats.ctimeNs !== opened.ctimeNs ||
      finalOpenedStats.dev !== opened.dev ||
      finalOpenedStats.ino !== opened.ino ||
      finalOpenedStats.size !== opened.size ||
      finalOpenedStats.mtimeNs !== opened.mtimeNs ||
      finalOpenedStats.ctimeNs !== opened.ctimeNs
    ) {
      throw executableFault(sourceCli);
    }

    return Object.freeze({
      path: path.resolve(candidate),
      device: identityPart(opened.dev),
      inode: identityPart(opened.ino),
      size: identityPart(opened.size),
      modifiedNanoseconds: identityPart(opened.mtimeNs),
      changedNanoseconds: identityPart(opened.ctimeNs),
      digest: `sha256:${digest.digest('hex')}`,
    });
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw executableFault(sourceCli);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function executableIdentityMatches(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds &&
    left.digest === right.digest
  );
}

async function isTrustedExecutable(candidate: string): Promise<boolean> {
  try {
    const sourceCli = /codex/i.test(path.basename(candidate))
      ? 'codex'
      : 'claude-code';
    await captureExecutableIdentity(candidate, sourceCli);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(sourceCli: SourceCli): readonly string[] {
  if (process.platform === 'win32') {
    return sourceCli === 'claude-code'
      ? ['claude.exe']
      : ['codex.exe'];
  }
  return sourceCli === 'claude-code' ? ['claude'] : ['codex'];
}

export async function resolveTrustedBinary(
  sourceCli: SourceCli,
  config: RuntimeConfig,
): Promise<string> {
  const override = config.binaryOverrides[sourceCli];
  if (override !== undefined) {
    if (await isTrustedExecutable(override)) return path.resolve(override);
    throw new RuntimeFault('cli-not-found', 'probe', sourceCli);
  }
  const pathEntries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  for (const directory of pathEntries) {
    for (const name of candidateNames(sourceCli)) {
      const candidate = path.resolve(directory, name);
      if (await isTrustedExecutable(candidate)) return candidate;
    }
  }
  throw new RuntimeFault('cli-not-found', 'probe', sourceCli);
}

function probeEnvironment(directory: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_CACHE_HOME: path.join(directory, 'cache'),
    XDG_STATE_HOME: path.join(directory, 'state'),
    TMPDIR: path.join(directory, 'tmp'),
    TEMP: path.join(directory, 'tmp'),
    TMP: path.join(directory, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot !== undefined) {
      environment.SystemRoot = systemRoot;
      environment.WINDIR = systemRoot;
    }
  }
  return environment;
}

export function parseProbeEvidence(
  adapter: RuntimeAdapter,
  outputs: readonly string[],
): ProbeEvidence {
  const commands = adapter.profiles[0]?.probeCommands;
  if (
    commands === undefined ||
    outputs.length !== commands.length ||
    adapter.profiles.some(
      (profile) =>
        JSON.stringify(profile.probeCommands) !==
        JSON.stringify(commands),
    )
  ) {
    throw new RuntimeFault(
      'cli-probe-failed',
      'probe',
      adapter.sourceCli,
    );
  }

  const versionLines = (outputs[0] ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const versionGrammar =
    adapter.sourceCli === 'claude-code'
      ? /^Claude Code (\d+\.\d+\.\d+)$/u
      : /^codex-cli (\d+\.\d+\.\d+)$/u;
  if (versionLines.length !== 1) {
    throw new RuntimeFault('cli-probe-failed', 'probe', adapter.sourceCli);
  }
  const versionMatch = versionGrammar.exec(versionLines[0]!);
  if (versionMatch?.[1] === undefined) {
    throw new RuntimeFault('cli-probe-failed', 'probe', adapter.sourceCli);
  }

  const records: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> =
    adapter.sourceCli === 'claude-code'
      ? Object.freeze({
          help: Object.freeze({
            '--print': Object.freeze(['--print']),
            '--resume <session-id>': Object.freeze(['--resume']),
            '--dangerously-skip-permissions': Object.freeze([
              '--dangerously-skip-permissions',
            ]),
            'stdin prompt supported': Object.freeze(['stdin']),
            'isolated-home supported': Object.freeze(['isolated-home']),
            'ANTHROPIC_BASE_URL route override': Object.freeze([
              'anthropic_base_url',
            ]),
          }),
        })
      : Object.freeze({
          help: Object.freeze({
            'CODEX_HOME isolated': Object.freeze(['codex_home']),
            'model_provider config supported': Object.freeze([
              'model_provider',
            ]),
            'base_url_env config supported': Object.freeze([
              'base_url_env',
            ]),
            'env_key config supported': Object.freeze(['env_key']),
            'wire_api = responses': Object.freeze([
              'wire_api',
              'responses',
            ]),
          }),
          'exec-help': Object.freeze({
            'Usage: codex exec [options]': Object.freeze([]),
            'exec resume <session-id> -': Object.freeze([
              'exec',
              'resume',
            ]),
            'stdin prompt supported': Object.freeze(['stdin']),
          }),
        });
  const knownMarkers = new Set(
    adapter.profiles.flatMap((profile) => profile.requiredMarkers),
  );
  const present = new Set<string>();
  for (let index = 1; index < outputs.length; index += 1) {
    const command = commands[index]!;
    const commandRecords = records[command.id] ?? {};
    const lines = outputs[index]!
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const seenRecords = new Set<string>();
    for (const line of lines) {
      if (/\d+\.\d+\.\d+/u.test(line)) {
        throw new RuntimeFault(
          'cli-probe-failed',
          'probe',
          adapter.sourceCli,
        );
      }
      const markers = commandRecords[line];
      if (markers !== undefined) {
        if (seenRecords.has(line)) {
          throw new RuntimeFault(
            'cli-probe-failed',
            'probe',
            adapter.sourceCli,
          );
        }
        seenRecords.add(line);
        for (const marker of markers) present.add(marker);
        continue;
      }
      const normalized = line.toLowerCase();
      if (
        [...knownMarkers].some((marker) =>
          normalized.includes(marker.toLowerCase()),
        )
      ) {
        throw new RuntimeFault(
          'cli-probe-failed',
          'probe',
          adapter.sourceCli,
        );
      }
    }
  }
  return Object.freeze({
    sourceCli: adapter.sourceCli,
    version: versionMatch[1],
    normalizedMarkers: present,
  });
}

export async function probeAdapter(
  adapter: RuntimeAdapter,
  executable: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
  expectedIdentity?: ExecutableIdentity,
): Promise<ProbeEvidence> {
  let directory: string | null = null;
  try {
    directory = await mkdtemp(
      path.join(tmpdir(), 'mosga-replay-probe-'),
    );
    await chmod(directory, 0o700);
    const commands = adapter.profiles[0]?.probeCommands;
    if (
      commands === undefined ||
      adapter.profiles.some(
        (profile) =>
          JSON.stringify(profile.probeCommands) !==
          JSON.stringify(commands),
      )
    ) {
      throw new RuntimeFault(
        'cli-capability-unsupported',
        'probe',
        adapter.sourceCli,
      );
    }
    // Stage an owned immutable copy of the probe executable (closes STD-M1 for
    // probes). superviseProbeProcess re-verifies this copy's identity before
    // each spawn, so a swap at the original path between commands has no effect.
    const sourceIdentity =
      expectedIdentity ??
      (await captureExecutableIdentity(executable, adapter.sourceCli));
    const owned = await stageOwnedExecutable(
      executable,
      directory,
      sourceIdentity,
      adapter.sourceCli,
    );
    const environment = probeEnvironment(directory);
    const signals = signal === undefined ? [] : [signal];
    const outputs: string[] = [];
    for (const command of commands) {
      const result = await superviseProbeProcess(
        owned,
        command,
        directory,
        environment,
        config,
        adapter.sourceCli,
        signals,
      );
      outputs.push(result.output);
    }
    return parseProbeEvidence(adapter, outputs);
  } finally {
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
