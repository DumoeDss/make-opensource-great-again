import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  type CanonicalRepository,
  type DatasetManifest,
  PublicationError,
} from './types.js';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PLACEHOLDER_LICENSE = /^(?:tbd|todo|unknown|none|n\/a|open question\b)/i;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_SCHEMA_VERSIONS = 100;
const MAX_SCHEMA_LENGTH = 100;
const MAX_LICENSE_LENGTH = 200;

const ManifestSchema = z
  .object({
    kind: z.literal('mosga-community-data'),
    contractVersion: z.literal(1),
    acceptedSchemaVersions: z
      .array(z.string().min(1).max(MAX_SCHEMA_LENGTH))
      .min(1)
      .max(MAX_SCHEMA_VERSIONS),
    license: z.string().min(1).max(MAX_LICENSE_LENGTH),
  })
  .strict();

function invalidTarget(): never {
  throw new PublicationError({
    code: 'invalid_target',
    phase: 'target',
    message: 'Enter a canonical GitHub repository as owner/repo.',
    retryable: false,
  });
}
export function parseCanonicalRepository(input: unknown): CanonicalRepository {
  if (typeof input !== 'string' || input.trim() !== input || input.length > 140) {
    return invalidTarget();
  }
  if (
    input.includes('://') ||
    input.includes('@') ||
    input.includes(':') ||
    input.includes('\\') ||
    input.includes('?') ||
    input.includes('#') ||
    /[\u0000-\u0020\u007f]/.test(input)
  ) {
    return invalidTarget();
  }
  const parts = input.split('/');
  if (
    parts.length !== 2 ||
    !OWNER_RE.test(parts[0]) ||
    !REPO_RE.test(parts[1]) ||
    parts[1] === '.' ||
    parts[1] === '..' ||
    parts[1].endsWith('.git')
  ) {
    return invalidTarget();
  }
  return { owner: parts[0], repo: parts[1], slug: `${parts[0]}/${parts[1]}` };
}

export function parseDatasetManifest(contents: unknown): DatasetManifest {
  if (
    typeof contents !== 'string' ||
    Buffer.byteLength(contents, 'utf8') > MAX_MANIFEST_BYTES
  ) {
    throw new PublicationError({
      code: 'target_incompatible',
      phase: 'target',
      message: 'The repository compatibility manifest is invalid.',
      retryable: false,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new PublicationError({
      code: 'target_incompatible',
      phase: 'target',
      message: 'The repository compatibility manifest is invalid.',
      retryable: false,
    });
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PublicationError({
      code: 'target_incompatible',
      phase: 'target',
      message: 'The repository compatibility manifest is invalid.',
      retryable: false,
    });
  }
  const unique = new Set(parsed.data.acceptedSchemaVersions);
  if (
    unique.size !== parsed.data.acceptedSchemaVersions.length ||
    parsed.data.license.trim() !== parsed.data.license ||
    PLACEHOLDER_LICENSE.test(parsed.data.license.trim())
  ) {
    throw new PublicationError({
      code: 'target_incompatible',
      phase: 'target',
      message: 'The repository compatibility manifest is invalid.',
      retryable: false,
    });
  }
  return {
    ...parsed.data,
    acceptedSchemaVersions: [...parsed.data.acceptedSchemaVersions],
  };
}

export function assertManifestAccepts(
  manifest: DatasetManifest,
  schemaVersions: readonly string[],
): void {
  const accepted = new Set(manifest.acceptedSchemaVersions);
  if (schemaVersions.some((version) => !accepted.has(version))) {
    throw new PublicationError({
      code: 'target_incompatible',
      phase: 'preview',
      message: 'The target repository does not accept every selected record schema.',
      retryable: false,
    });
  }
}

export function sha256Utf8(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA256.test(value);
}
