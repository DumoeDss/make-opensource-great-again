import path from 'node:path';
import { tmpdir } from 'node:os';

import type { SourceCli } from '@mosga/contracts';

import { RuntimeFault } from './errors.js';
import type {
  ReplayRuntimeLimits,
  ReplayRuntimeOptions,
  ReplaySkillRoot,
} from './types.js';

export interface RuntimeConfig {
  readonly binaryOverrides: Readonly<Partial<Record<SourceCli, string>>>;
  readonly dedicatedTempBase: string;
  readonly limits: Required<ReplayRuntimeLimits>;
}

const DEFAULT_LIMITS: Required<ReplayRuntimeLimits> = Object.freeze({
  probeTimeoutMs: 5_000,
  executionTimeoutMs: 120_000,
  terminationGraceMs: 1_500,
  probeOutputBytes: 128 * 1024,
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 4 * 1024 * 1024,
  combinedOutputBytes: 6 * 1024 * 1024,
  terminalInputBytes: 256 * 1024,
  skillFileCount: 2_000,
  skillFileBytes: 4 * 1024 * 1024,
  skillTotalBytes: 32 * 1024 * 1024,
  staleRootAgeMs: 24 * 60 * 60 * 1_000,
});

const optionKeys = new Set(['binaryOverrides', 'tempBase', 'limits']);
const limitKeys = new Set(Object.keys(DEFAULT_LIMITS));

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validationFault(): never {
  throw new RuntimeFault(
    'runtime-policy-unsupported',
    'validate',
  );
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    validationFault();
  }
}

export function normalizeRuntimeOptions(
  options: ReplayRuntimeOptions,
): RuntimeConfig {
  if (!isPlainRecord(options)) validationFault();
  assertKnownKeys(options, optionKeys);

  const overrides = options.binaryOverrides ?? {};
  if (!isPlainRecord(overrides)) validationFault();
  assertKnownKeys(overrides, new Set(['claude-code', 'codex']));
  for (const value of Object.values(overrides)) {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.includes('\0')
    ) {
      validationFault();
    }
  }

  const limitsInput = options.limits ?? {};
  if (!isPlainRecord(limitsInput)) validationFault();
  assertKnownKeys(limitsInput, limitKeys);
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limitsInput)) {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > DEFAULT_LIMITS[key as keyof ReplayRuntimeLimits]
    ) {
      validationFault();
    }
    (limits as Record<string, number>)[key] = value;
  }
  if (
    limits.combinedOutputBytes <
      Math.max(limits.stdoutBytes, limits.stderrBytes) ||
    limits.skillTotalBytes < limits.skillFileBytes
  ) {
    validationFault();
  }

  const tempParent = options.tempBase ?? tmpdir();
  if (
    typeof tempParent !== 'string' ||
    !path.isAbsolute(tempParent) ||
    tempParent.includes('\0')
  ) {
    validationFault();
  }

  return Object.freeze({
    binaryOverrides: Object.freeze({ ...overrides }),
    dedicatedTempBase: path.join(
      path.resolve(tempParent),
      'mosga-replay-runtime-v1',
    ),
    limits: Object.freeze(limits),
  });
}

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeAlias(value: string): boolean {
  return SAFE_ALIAS.test(value) && value !== '.' && value !== '..';
}

export function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

export function validateSkillDescriptors(
  roots: readonly ReplaySkillRoot[] | undefined,
): readonly ReplaySkillRoot[] {
  if (roots === undefined) return Object.freeze([]);
  if (!Array.isArray(roots)) {
    throw new RuntimeFault('skill-root-invalid', 'validate');
  }
  const ids = new Set<string>();
  const parsed = roots.map((root) => {
    if (
      !isPlainRecord(root) ||
      Object.keys(root).some(
        (key) =>
          !['id', 'sourcePath', 'scope', 'precedence'].includes(key),
      ) ||
      typeof root.id !== 'string' ||
      !isSafeAlias(root.id) ||
      ids.has(root.id) ||
      typeof root.sourcePath !== 'string' ||
      !path.isAbsolute(root.sourcePath) ||
      root.sourcePath.includes('\0') ||
      (root.scope !== 'user' && root.scope !== 'project') ||
      typeof root.precedence !== 'number' ||
      !Number.isSafeInteger(root.precedence)
    ) {
      throw new RuntimeFault('skill-root-invalid', 'validate');
    }
    ids.add(root.id);
    return Object.freeze({
      id: root.id,
      sourcePath: path.resolve(root.sourcePath),
      scope: root.scope,
      precedence: root.precedence,
    });
  });
  parsed.sort(
    (left, right) =>
      left.precedence - right.precedence ||
      left.id.localeCompare(right.id, 'en'),
  );
  return Object.freeze(parsed);
}
