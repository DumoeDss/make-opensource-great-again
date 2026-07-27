import {
  ReplayBundleSchema,
  type ReplayBundlePayload,
  type SourceCli,
} from '@mosga/contracts';
import { validateReplayBundle } from '@mosga/replay-bundle';

import { isSafeAlias, isSafeRelativePath } from './config.js';
import { RuntimeFault } from './errors.js';

const validatedBundleBrand: unique symbol = Symbol(
  'mosga.replay-runtime.validated-bundle',
);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

export interface ValidatedReplayInput {
  readonly [validatedBundleBrand]: true;
  readonly payload: ReplayBundlePayload;
  readonly contentHash: `sha256:${string}`;
}

function validatePolicy(payload: ReplayBundlePayload): void {
  const policy = payload.runtimePolicy;
  const source = payload.source;
  const artifact = payload.nativeSession;
  const expectedFormat =
    source.sourceCli === 'claude-code'
      ? 'claude-code-jsonl'
      : source.sourceCli === 'codex'
        ? 'codex-jsonl'
        : null;
  if (
    payload.nativeSession.files.filter(
      (file) => file.role === 'primary',
    ).length !== 1
  ) {
    throw new RuntimeFault(
      'session-layout-unsupported',
      'validate',
      source.sourceCli,
    );
  }
  if (
    policy.schemaVersion !== '1.0.0' ||
    policy.replayMode !== 'cli-resume' ||
    policy.instructionPolicy !== 'sanitized-snapshot' ||
    policy.skillPolicy !== 'cli-discovery-read-only' ||
    policy.proxyRescan !== false ||
    policy.maxInferenceRequests !== 1 ||
    !isSafeAlias(policy.projectAlias) ||
    !isSafeRelativePath(policy.workingDirectoryAlias) ||
    policy.workingDirectoryAlias !==
      `workspace/${policy.projectAlias}` ||
    artifact.sourceCli !== source.sourceCli ||
    artifact.sourceFormat !== source.sourceFormat ||
    artifact.sessionIdAlias !== source.sessionIdAlias ||
    expectedFormat === null ||
    source.sourceFormat !== expectedFormat ||
    !isSafeAlias(source.sessionIdAlias)
  ) {
    throw new RuntimeFault(
      expectedFormat === null
        ? 'source-cli-unsupported'
        : 'runtime-policy-unsupported',
      'validate',
      source.sourceCli as SourceCli,
    );
  }
}

export function validateAndBrandReplayBundle(
  input: unknown,
): ValidatedReplayInput {
  let payload: ReplayBundlePayload;
  try {
    payload = validateReplayBundle(input);
  } catch {
    throw new RuntimeFault('bundle-invalid', 'validate');
  }

  const stored = ReplayBundleSchema.safeParse(input);
  if (!stored.success) {
    throw new RuntimeFault('bundle-invalid', 'validate');
  }
  validatePolicy(payload);
  return deepFreeze({
    [validatedBundleBrand]: true as const,
    payload,
    contentHash:
      stored.data.integrity.contentHash as `sha256:${string}`,
  });
}
