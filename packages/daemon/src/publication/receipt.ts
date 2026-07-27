import { parseCanonicalRepository } from './target.js';
import {
  PublicationError,
  type PublicationReceipt,
} from './types.js';

const RECEIPT_KEYS = [
  'baseBranch',
  'baseCommitSha',
  'branch',
  'commitSha',
  'contentDigest',
  'mode',
  'prNumber',
  'prUrl',
  'publicationRef',
  'pushRepository',
  'recordCount',
  'submittedAt',
  'targetRevision',
  'upstream',
].sort();

function unavailable(): never {
  throw new PublicationError({
    code: 'workspace_unavailable',
    phase: 'workspace',
    message: 'Publication recovery storage is unavailable.',
    retryable: true,
  });
}

function safeBranch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !/[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value) &&
    value.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !part.endsWith('.lock'),
    )
  );
}

export function validatePublicationReceipt(
  value: unknown,
): PublicationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return unavailable();
  }
  const raw = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(RECEIPT_KEYS) ||
    typeof raw.publicationRef !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(raw.publicationRef) ||
    !Number.isSafeInteger(raw.targetRevision) ||
    (raw.targetRevision as number) < 0 ||
    (raw.mode !== 'direct' && raw.mode !== 'fork') ||
    !safeBranch(raw.baseBranch) ||
    !safeBranch(raw.branch) ||
    typeof raw.baseCommitSha !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(raw.baseCommitSha) ||
    typeof raw.commitSha !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(raw.commitSha) ||
    !Number.isSafeInteger(raw.prNumber) ||
    (raw.prNumber as number) < 1 ||
    !Number.isSafeInteger(raw.recordCount) ||
    (raw.recordCount as number) < 1 ||
    (raw.recordCount as number) > 500 ||
    typeof raw.contentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.contentDigest) ||
    typeof raw.submittedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.submittedAt)) ||
    new Date(raw.submittedAt).toISOString() !== raw.submittedAt
  ) {
    return unavailable();
  }
  let upstream;
  let push;
  try {
    upstream = parseCanonicalRepository(raw.upstream);
    push = parseCanonicalRepository(raw.pushRepository);
  } catch {
    return unavailable();
  }
  if (
    (raw.mode === 'direct' &&
      push.slug.toLowerCase() !== upstream.slug.toLowerCase()) ||
    typeof raw.prUrl !== 'string' ||
    raw.prUrl !==
      `https://github.com/${upstream.slug}/pull/${String(raw.prNumber)}`
  ) {
    return unavailable();
  }
  return structuredClone(raw) as unknown as PublicationReceipt;
}
