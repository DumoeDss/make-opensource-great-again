import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  canonicalizeReplayReviewedDraft,
  ReplayBundlePayloadSchema,
  ReplayBundleSchema,
  type ReplayBundle,
  type ReplayBundlePayload,
  type ReplayIntegrityEntry,
} from '@mosga/contracts';

import {
  canonicalizeReplayJson,
  serializeInstructionFile,
  serializeNativeJsonl,
} from './canonical.js';

const REPLAY_BUNDLE_DOMAIN = 'mosga-replay-bundle:v1' as const;

export type ReplayBundleIntegrityErrorCode =
  | 'invalid-payload'
  | 'review-gate-locked'
  | 'review-content-mismatch'
  | 'payload-identity-mismatch'
  | 'unsafe-entry-path'
  | 'duplicate-entry-path'
  | 'serialization-failed'
  | 'invalid-bundle'
  | 'unsupported-version'
  | 'malformed-digest'
  | 'manifest-mismatch'
  | 'content-hash-mismatch';

interface CodedIntegrityError extends Error {
  code: ReplayBundleIntegrityErrorCode;
}

function integrityFailure(
  code: ReplayBundleIntegrityErrorCode,
  message: string,
): never {
  const error = new Error(message) as CodedIntegrityError;
  error.name = 'ReplayBundleIntegrityError';
  error.code = code;
  throw error;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function isSafeReplayEntryPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  return path
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function computeReplayReviewedDraftHash(
  payload: ReplayBundlePayload,
): `sha256:${string}` {
  return digest(canonicalizeReplayReviewedDraft(payload));
}

function assertReviewedDraftBinding(
  payload: ReplayBundlePayload,
): void {
  if (
    payload.review.reviewedDraftHash !==
    computeReplayReviewedDraftHash(payload)
  ) {
    integrityFailure(
      'review-content-mismatch',
      'ReplayBundle content does not match the reviewed draft.',
    );
  }
}

function assertPayloadIdentity(payload: ReplayBundlePayload): void {
  const { terminalManifestSeed: seed, runtimePolicy: policy } = payload;
  const matches =
    payload.review.draftId === payload.draftId &&
    payload.review.rulesetVersion ===
      seed.sanitization.rulesetVersion &&
    payload.review.reportVersion ===
      seed.sanitization.reportVersion &&
    isDeepStrictEqual(seed.source, payload.source) &&
    isDeepStrictEqual(seed.delivery, payload.delivery) &&
    payload.nativeSession.sourceCli === payload.source.sourceCli &&
    payload.nativeSession.sourceFormat === payload.source.sourceFormat &&
    payload.nativeSession.sessionIdAlias ===
      payload.source.sessionIdAlias &&
    seed.replayMode === policy.replayMode &&
    seed.instructionPolicy === policy.instructionPolicy &&
    seed.skillPolicy === policy.skillPolicy &&
    seed.proxyRescan === policy.proxyRescan &&
    seed.maxInferenceRequests === policy.maxInferenceRequests;
  if (!matches) {
    integrityFailure(
      'payload-identity-mismatch',
      'ReplayBundle payload identities do not match.',
    );
  }
}

function assertReviewUnlocked(payload: ReplayBundlePayload): void {
  if (
    payload.review.findings.some(
      (finding) =>
        finding.blocking && finding.disposition === 'pending',
    ) ||
    payload.review.opaqueItems.some(
      (item) => item.disposition === 'pending',
    )
  ) {
    integrityFailure(
      'review-gate-locked',
      'ReplayBundle review still has pending blocking decisions.',
    );
  }
  if (
    payload.review.findings.some(
      (finding) =>
        finding.layer === 'normalization' &&
        (finding.disposition === 'pending' ||
          finding.disposition === 'allow'),
    )
  ) {
    integrityFailure(
      'review-gate-locked',
      'ReplayBundle review still has unresolved or retained privacy normalization findings.',
    );
  }
}

export function deriveReplayIntegrityEntries(
  payload: ReplayBundlePayload,
): ReplayIntegrityEntry[] {
  const content: Array<{
    path: string;
    mediaType: ReplayIntegrityEntry['mediaType'];
    bytes: Uint8Array;
  }> = [];
  try {
    for (const file of payload.nativeSession.files) {
      content.push({
        path: file.logicalPath,
        mediaType: 'application/jsonl',
        bytes: serializeNativeJsonl(file),
      });
    }
    for (const file of payload.instructionSnapshot.files) {
      const basename = file.stagePath.split('/').at(-1);
      const expectedBasename =
        file.kind === 'claude-md' ? 'CLAUDE.md' : 'AGENTS.md';
      if (basename !== expectedBasename) {
        integrityFailure(
          'unsafe-entry-path',
          'ReplayBundle instruction entry path has an unrecognized basename.',
        );
      }
      content.push({
        path: file.stagePath,
        mediaType: 'text/markdown; charset=utf-8',
        bytes: serializeInstructionFile(file),
      });
    }
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error
    ) {
      throw error;
    }
    integrityFailure(
      'serialization-failed',
      'ReplayBundle content entry serialization failed.',
    );
  }

  content.sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  for (let index = 0; index < content.length; index += 1) {
    const entry = content[index]!;
    if (!isSafeReplayEntryPath(entry.path)) {
      integrityFailure(
        'unsafe-entry-path',
        'ReplayBundle content entry path is unsafe.',
      );
    }
    if (
      index > 0 &&
      content[index - 1]!.path === entry.path
    ) {
      integrityFailure(
        'duplicate-entry-path',
        'ReplayBundle content entry paths must be unique.',
      );
    }
  }

  return content.map((entry) => ({
    path: entry.path,
    mediaType: entry.mediaType,
    byteLength: entry.bytes.byteLength,
    digest: digest(entry.bytes),
  }));
}

export function computeReplayBundleContentHash(
  payload: ReplayBundlePayload,
  entries: ReplayIntegrityEntry[],
): `sha256:${string}` {
  return digest(
    canonicalizeReplayJson({
      domain: REPLAY_BUNDLE_DOMAIN,
      payload,
      entries,
    }),
  );
}

/** Pure domain-separated sealing entry point. */
export function sealReplayBundle(
  input: ReplayBundlePayload,
): ReplayBundle {
  const parsed = ReplayBundlePayloadSchema.safeParse(input);
  if (!parsed.success) {
    return integrityFailure(
      'invalid-payload',
      'ReplayBundle payload is invalid.',
    );
  }
  const payload = parsed.data;
  assertReviewedDraftBinding(payload);
  assertPayloadIdentity(payload);
  assertReviewUnlocked(payload);
  const entries = deriveReplayIntegrityEntries(payload);
  const bundle = ReplayBundleSchema.safeParse({
    payload,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'mosga-replay-canonical-json-v1',
      entries,
      contentHash: computeReplayBundleContentHash(payload, entries),
    },
  });
  if (!bundle.success) {
    return integrityFailure(
      'serialization-failed',
      'ReplayBundle seal could not be represented by the contract.',
    );
  }
  return structuredClone(bundle.data);
}

function objectValue(
  value: unknown,
  key: string,
): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function preflightStoredBundle(input: unknown): void {
  const payload = objectValue(input, 'payload');
  const integrity = objectValue(input, 'integrity');
  const schemaVersion = objectValue(payload, 'schemaVersion');
  const algorithm = objectValue(integrity, 'algorithm');
  const canonicalization = objectValue(
    integrity,
    'canonicalization',
  );
  if (
    (schemaVersion !== undefined && schemaVersion !== '1.0.0') ||
    (algorithm !== undefined && algorithm !== 'sha256') ||
    (canonicalization !== undefined &&
      canonicalization !== 'mosga-replay-canonical-json-v1')
  ) {
    integrityFailure(
      'unsupported-version',
      'ReplayBundle version or integrity protocol is unsupported.',
    );
  }

  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  const contentHash = objectValue(integrity, 'contentHash');
  const entries = objectValue(integrity, 'entries');
  const malformedContentHash =
    typeof contentHash === 'string' && !digestPattern.test(contentHash);
  const malformedEntryDigest =
    Array.isArray(entries) &&
    entries.some((entry) => {
      const entryDigest = objectValue(entry, 'digest');
      return (
        typeof entryDigest === 'string' &&
        !digestPattern.test(entryDigest)
      );
    });
  if (malformedContentHash || malformedEntryDigest) {
    integrityFailure(
      'malformed-digest',
      'ReplayBundle digest format is malformed.',
    );
  }
}

/** Self-contained fail-closed validation entry point. */
export function validateReplayBundle(
  input: unknown,
): ReplayBundlePayload {
  preflightStoredBundle(input);
  const parsed = ReplayBundleSchema.safeParse(input);
  if (!parsed.success) {
    return integrityFailure(
      'invalid-bundle',
      'ReplayBundle contract validation failed.',
    );
  }
  const bundle = parsed.data;
  assertReviewedDraftBinding(bundle.payload);
  assertPayloadIdentity(bundle.payload);
  assertReviewUnlocked(bundle.payload);
  if (
    bundle.integrity.entries.some(
      (entry) => !isSafeReplayEntryPath(entry.path),
    )
  ) {
    return integrityFailure(
      'unsafe-entry-path',
      'ReplayBundle stored entry path is unsafe.',
    );
  }

  const expectedEntries = deriveReplayIntegrityEntries(bundle.payload);
  if (!isDeepStrictEqual(bundle.integrity.entries, expectedEntries)) {
    return integrityFailure(
      'manifest-mismatch',
      'ReplayBundle entry manifest does not match its payload content.',
    );
  }
  const expectedRoot = computeReplayBundleContentHash(
    bundle.payload,
    expectedEntries,
  );
  if (bundle.integrity.contentHash !== expectedRoot) {
    return integrityFailure(
      'content-hash-mismatch',
      'ReplayBundle root content hash does not match.',
    );
  }
  return structuredClone(bundle.payload);
}
