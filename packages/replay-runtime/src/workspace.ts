import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import {
  serializeInstructionFile,
  serializeNativeJsonl,
} from '@mosga/replay-bundle';

import type { CapabilityProfile, AdapterPaths } from './adapters/types.js';
import type { RuntimeConfig } from './config.js';
import { isSafeRelativePath } from './config.js';
import { RuntimeFault } from './errors.js';
import type { ValidatedReplayInput } from './validated.js';

const OWNER_MARKER = '.mosga-replay-owner.json';
const OWNER_SCHEMA = 'mosga-replay-owner-v1';

export interface ReplayRootOwnership {
  readonly root: string;
  readonly rootId: string;
}

export interface ReplayWorkspace {
  readonly paths: AdapterPaths;
  readonly rootId: string;
  readonly inventory: readonly string[];
  readonly ownership: ReplayRootOwnership;
}

export interface ReplayWorkspaceHooks {
  beforeMarkerWrite?(root: string): void | Promise<void>;
  beforeMaterializedWrite?(
    kind: 'native' | 'instruction' | 'control',
    index: number,
    destination: string,
  ): void | Promise<void>;
  beforeRemoveRoot?(root: string): void | Promise<void>;
}

const ownershipState = new WeakMap<
  ReplayRootOwnership,
  { markerWritten: boolean }
>();

async function makeOwnerPrivate(root: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(root, 0o700);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const username = process.env.USERNAME;
  if (systemRoot === undefined || username === undefined) {
    throw new Error('owner ACL identity unavailable');
  }
  const domain = process.env.USERDOMAIN;
  const principal =
    domain === undefined || domain.length === 0
      ? username
      : `${domain}\\${username}`;
  const executable = path.join(
    systemRoot,
    'System32',
    'icacls.exe',
  );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const child = spawn(
      executable,
      [
        root,
        '/inheritance:r',
        '/grant:r',
        `${principal}:(OI)(CI)F`,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
        },
      },
    );
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      if (error === null) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('owner ACL timed out'));
    }, 5_000);
    timer.unref();
    child.once('error', () => finish(new Error('owner ACL failed')));
    child.once('close', (code) =>
      finish(code === 0 ? null : new Error('owner ACL failed')),
    );
  });
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function resolveContainedPath(
  root: string,
  relativePath: string,
): string {
  if (!isSafeRelativePath(relativePath)) {
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
    );
  }
  const destination = path.resolve(
    root,
    ...relativePath.split('/'),
  );
  if (!isContained(root, destination)) {
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
    );
  }
  return destination;
}

async function ensureDirectory(
  root: string,
  destination: string,
): Promise<void> {
  if (
    destination !== root &&
    !isContained(root, destination)
  ) {
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
    );
  }
  const relative = path.relative(root, destination);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const existing = await lstat(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new RuntimeFault(
          'workspace-materialize-failed',
          'materialize',
        );
      }
    } catch (error) {
      if (
        error instanceof RuntimeFault
      ) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

function assertNonOverlapping(paths: readonly string[]): void {
  const sorted = paths
    .map((value) => ({
      value,
      key: process.platform === 'win32' ? value.toLowerCase() : value,
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!.key;
    const previous = sorted[index - 1]?.key;
    if (
      previous !== undefined &&
      (current === previous ||
        current.startsWith(`${previous}${path.sep}`) ||
        previous.startsWith(`${current}${path.sep}`))
    ) {
      throw new RuntimeFault(
        'workspace-materialize-failed',
        'materialize',
      );
    }
  }
}

async function atomicWrite(
  root: string,
  destination: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  await ensureDirectory(root, path.dirname(destination));
  try {
    await lstat(destination);
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
    );
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.mosga-${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, mode);
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function validateStoragePlan(
  validated: ValidatedReplayInput,
  relativePaths: readonly string[],
): void {
  const files = validated.payload.nativeSession.files;
  if (
    relativePaths.length !== files.length ||
    new Set(relativePaths).size !== relativePaths.length ||
    relativePaths.some((entry) => !isSafeRelativePath(entry))
  ) {
    throw new RuntimeFault(
      'session-layout-unsupported',
      'materialize',
      validated.payload.source.sourceCli,
    );
  }
}

function assertControlFile(
  profile: CapabilityProfile,
  relativePath: string,
  bytes: Uint8Array,
): void {
  if (
    profile.sourceCli !== 'codex' ||
    relativePath !== 'cli-home/.codex/config.toml'
  ) {
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
      profile.sourceCli,
    );
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const exact = [
    'model_provider = "mosga-local"',
    '',
    '[model_providers.mosga-local]',
    'name = "MOSGA local replay route"',
    'base_url_env = "MOSGA_ROUTE_BASE_URL"',
    'env_key = "MOSGA_ROUTE_TOKEN"',
    'wire_api = "responses"',
    '',
  ].join('\n');
  if (content !== exact) {
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
      profile.sourceCli,
    );
  }
}

async function createRoot(
  config: RuntimeConfig,
  claimOwnership: (ownership: ReplayRootOwnership) => void,
  hooks: ReplayWorkspaceHooks,
): Promise<ReplayRootOwnership> {
  try {
    await mkdir(config.dedicatedTempBase, {
      recursive: true,
      mode: 0o700,
    });
    const baseStats = await lstat(config.dedicatedTempBase);
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) {
      throw new Error('unsafe base');
    }
    const baseReal = await realpath(config.dedicatedTempBase);
    if (
      path.resolve(baseReal) !==
      path.resolve(config.dedicatedTempBase)
    ) {
      throw new Error('aliased base');
    }
    const root = await mkdtemp(
      path.join(config.dedicatedTempBase, 'replay-'),
    );
    const rootId = randomUUID();
    const ownership = Object.freeze({ root, rootId });
    ownershipState.set(ownership, { markerWritten: false });
    claimOwnership(ownership);
    await makeOwnerPrivate(root);
    const marker = new TextEncoder().encode(
      `${JSON.stringify({
        schema: OWNER_SCHEMA,
        rootId,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    await hooks.beforeMarkerWrite?.(root);
    await atomicWrite(root, path.join(root, OWNER_MARKER), marker, 0o400);
    ownershipState.get(ownership)!.markerWritten = true;
    return ownership;
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw new RuntimeFault('workspace-create-failed', 'materialize');
  }
}

export async function createReplayWorkspace(
  config: RuntimeConfig,
  validated: ValidatedReplayInput,
  profile: CapabilityProfile,
  claimOwnership: (ownership: ReplayRootOwnership) => void,
  hooks: ReplayWorkspaceHooks = {},
): Promise<ReplayWorkspace> {
  let ownership: ReplayRootOwnership;
  try {
    ownership = await createRoot(config, claimOwnership, hooks);
    const { root, rootId } = ownership;
    const paths: AdapterPaths = Object.freeze({
      root,
      cliHome: path.join(root, 'cli-home'),
      workspace: path.join(root, 'workspace'),
      workingDirectory: resolveContainedPath(
        root,
        validated.payload.runtimePolicy.workingDirectoryAlias,
      ),
      runtime: path.join(root, 'runtime'),
      cache: path.join(root, 'cache'),
      temporary: path.join(root, 'tmp'),
    });
    for (const directory of [
      paths.cliHome,
      paths.workspace,
      paths.workingDirectory,
      paths.runtime,
      paths.cache,
      paths.temporary,
    ]) {
      await ensureDirectory(root, directory);
    }

    const storage = profile.storagePlan(validated);
    const nativeRelativePaths = storage.nativeFiles.map(
      (entry) => entry.relativePath,
    );
    validateStoragePlan(validated, nativeRelativePaths);
    const instructionRelativePaths =
      validated.payload.instructionSnapshot.files.map(
        (file) => file.stagePath,
      );
    const controls = profile.controlFiles(validated, paths);
    const controlRelativePaths = controls.map(
      (control) => control.relativePath,
    );
    const allRelativePaths = [
      ...nativeRelativePaths,
      ...instructionRelativePaths,
      ...controlRelativePaths,
    ];
    const destinations = allRelativePaths.map((relativePath) =>
      resolveContainedPath(root, relativePath),
    );
    assertNonOverlapping(destinations);

    for (let index = 0; index < storage.nativeFiles.length; index += 1) {
      const entry = storage.nativeFiles[index]!;
      if (
        entry.file.id !==
        validated.payload.nativeSession.files[index]?.id
      ) {
        throw new RuntimeFault(
          'session-layout-unsupported',
          'materialize',
          profile.sourceCli,
        );
      }
      const bytes = serializeNativeJsonl(entry.file);
      const destination = resolveContainedPath(root, entry.relativePath);
      await hooks.beforeMaterializedWrite?.(
        'native',
        index,
        destination,
      );
      await atomicWrite(
        root,
        destination,
        bytes,
        0o600,
      );
    }

    for (
      let index = 0;
      index < validated.payload.instructionSnapshot.files.length;
      index += 1
    ) {
      const file =
        validated.payload.instructionSnapshot.files[index]!;
      try {
        const bytes = serializeInstructionFile(file);
        const destination = resolveContainedPath(root, file.stagePath);
        await hooks.beforeMaterializedWrite?.(
          'instruction',
          index,
          destination,
        );
        await atomicWrite(
          root,
          destination,
          bytes,
          0o400,
        );
      } catch (error) {
        if (error instanceof RuntimeFault) throw error;
        throw new RuntimeFault(
          'instruction-stage-failed',
          'materialize',
          profile.sourceCli,
        );
      }
    }

    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index]!;
      assertControlFile(
        profile,
        control.relativePath,
        control.bytes,
      );
      const destination = resolveContainedPath(
        root,
        control.relativePath,
      );
      await hooks.beforeMaterializedWrite?.(
        'control',
        index,
        destination,
      );
      await atomicWrite(
        root,
        destination,
        control.bytes,
        0o600,
      );
    }

    for (const destination of destinations) {
      const fileStats = await lstat(destination);
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
        throw new RuntimeFault(
          'workspace-materialize-failed',
          'materialize',
          profile.sourceCli,
        );
      }
    }
    return Object.freeze({
      paths,
      rootId,
      inventory: Object.freeze([...allRelativePaths]),
      ownership,
    });
  } catch (error) {
    if (error instanceof RuntimeFault) throw error;
    throw new RuntimeFault(
      'workspace-materialize-failed',
      'materialize',
      profile.sourceCli,
    );
  }
}

async function validOwnerMarker(
  candidate: string,
): Promise<{ createdAt: number; rootId: string } | null> {
  try {
    const markerPath = path.join(candidate, OWNER_MARKER);
    const markerStats = await lstat(markerPath);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) return null;
    const raw = await readFile(markerPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (
      value === null ||
      typeof value !== 'object' ||
      (value as Record<string, unknown>).schema !== OWNER_SCHEMA ||
      typeof (value as Record<string, unknown>).rootId !== 'string' ||
      typeof (value as Record<string, unknown>).createdAt !== 'string'
    ) {
      return null;
    }
    const createdAt = Date.parse(
      (value as Record<string, string>).createdAt,
    );
    return Number.isFinite(createdAt)
      ? {
          createdAt,
          rootId: (value as Record<string, string>).rootId,
        }
      : null;
  } catch {
    return null;
  }
}

async function makeTreeWritable(root: string): Promise<void> {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch {
    return;
  }
  if (rootStats.isSymbolicLink()) {
    return;
  }
  if (!rootStats.isDirectory()) {
    await chmod(root, 0o600).catch(() => {});
    return;
  }
  await chmod(root, 0o700).catch(() => {});
  const entries = await readdir(root, {
    withFileTypes: true,
    encoding: 'utf8',
  }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isDirectory()) {
      await makeTreeWritable(child);
    } else {
      await chmod(child, 0o600).catch(() => {});
    }
  }
}

export async function cleanupReplayWorkspace(
  target: ReplayWorkspace | ReplayRootOwnership,
  config: RuntimeConfig,
  hooks: ReplayWorkspaceHooks = {},
): Promise<void> {
  const ownership =
    'ownership' in target ? target.ownership : target;
  const state = ownershipState.get(ownership);
  if (state === undefined) {
    throw new RuntimeFault('cleanup-failed', 'cleanup');
  }
  const root = path.resolve(ownership.root);
  const base = path.resolve(config.dedicatedTempBase);
  if (
    !isContained(base, root) ||
    !path.basename(root).startsWith('replay-')
  ) {
    throw new RuntimeFault('cleanup-failed', 'cleanup');
  }
  const rootStats = await lstat(root).catch(() => null);
  if (
    rootStats === null ||
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink()
  ) {
    throw new RuntimeFault('cleanup-failed', 'cleanup');
  }
  if (state.markerWritten) {
    const marker = await validOwnerMarker(root);
    if (marker === null || marker.rootId !== ownership.rootId) {
      throw new RuntimeFault('cleanup-failed', 'cleanup');
    }
  }
  try {
    await makeTreeWritable(root);
    await hooks.beforeRemoveRoot?.(root);
    await rm(root, { recursive: true, force: true });
    try {
      await stat(root);
      throw new Error('root remains');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch {
    throw new RuntimeFault('cleanup-failed', 'cleanup');
  }
}

export async function cleanupStaleReplayRoots(
  config: RuntimeConfig,
  now = Date.now(),
): Promise<void> {
  let entries;
  try {
    const baseStats = await lstat(config.dedicatedTempBase);
    if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) return;
    entries = await readdir(config.dedicatedTempBase, {
      withFileTypes: true,
      encoding: 'utf8',
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.name.startsWith('replay-') ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    const candidate = path.resolve(
      config.dedicatedTempBase,
      entry.name,
    );
    if (
      !isContained(
        path.resolve(config.dedicatedTempBase),
        candidate,
      )
    ) {
      continue;
    }
    const marker = await validOwnerMarker(candidate);
    if (
      marker === null ||
      now - marker.createdAt < config.limits.staleRootAgeMs
    ) {
      continue;
    }
    await makeTreeWritable(candidate);
    await rm(candidate, { recursive: true, force: true }).catch(() => {});
  }
}
