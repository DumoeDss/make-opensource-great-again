import { createHash } from 'node:crypto';

import {
  CONTRIBUTION_BUNDLE_CONTRACT_VERSION,
  computeContributionContentDigest,
  type ContributionBundle,
} from '@mosga/publisher';

import { PublicationError } from './types.js';

const HEX64 = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const BRANCH_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\]/;

function invalidBundle(): never {
  throw new PublicationError({
    code: 'preview_stale',
    phase: 'preview',
    message: 'The contribution bundle failed integrity validation.',
    retryable: false,
  });
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateBranch(branch: string, digest: string): void {
  if (
    branch.length === 0 ||
    branch.length > 255 ||
    !branch.startsWith('contrib/') ||
    !branch.endsWith(`-${digest.slice(0, 8)}`) ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    BRANCH_FORBIDDEN.test(branch)
  ) {
    invalidBundle();
  }
  for (const segment of branch.split('/')) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      segment.endsWith('.') ||
      segment.toLowerCase().endsWith('.lock')
    ) {
      invalidBundle();
    }
  }
}

export function canonicalPortablePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return invalidBundle();
  }
  const segments = path.split('/');
  if (
    segments.length < 2 ||
    segments[0] !== 'data' ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        /[<>:"|?*]/.test(segment) ||
        WINDOWS_DEVICE.test(segment),
    )
  ) {
    return invalidBundle();
  }
  return segments
    .map((segment) => segment.normalize('NFC').toLocaleLowerCase('en-US'))
    .join('/');
}

export function validateContributionBundle(bundle: ContributionBundle): ContributionBundle {
  if (
    bundle.contractVersion !== CONTRIBUTION_BUNDLE_CONTRACT_VERSION ||
    !Number.isSafeInteger(bundle.recordCount) ||
    bundle.recordCount < 1 ||
    bundle.recordCount > 500 ||
    bundle.records.length !== bundle.recordCount ||
    bundle.files.length !== bundle.recordCount * 2 ||
    !Number.isSafeInteger(bundle.totalBytes) ||
    bundle.totalBytes < 0 ||
    !HEX64.test(bundle.contentDigest) ||
    !isWellFormedUtf16(bundle.contributorAlias) ||
    bundle.contributorAlias.length === 0
  ) {
    return invalidBundle();
  }
  const engineValues = [
    bundle.engine.sanitizerPackageVersion,
    bundle.engine.rulesetVersion,
    bundle.engine.gitleaksVersion,
  ];
  if (
    engineValues.some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 500 ||
        /[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    return invalidBundle();
  }
  if (
    [bundle.commitMessage, bundle.prTitle, bundle.prBody].some(
      (value) =>
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 200_000 ||
        !isWellFormedUtf16(value),
    )
  ) {
    return invalidBundle();
  }
  validateBranch(bundle.branch, bundle.contentDigest);

  const sessionIds = new Set<string>();
  const recordPaths = new Set<string>();
  const provenancePaths = new Set<string>();
  let previousSessionId: string | undefined;
  for (const record of bundle.records) {
    if (
      typeof record.sessionId !== 'string' ||
      record.sessionId.length === 0 ||
      record.sessionId.length > 500 ||
      !isWellFormedUtf16(record.sessionId) ||
      sessionIds.has(record.sessionId) ||
      (previousSessionId !== undefined &&
        ordinalCompare(previousSessionId, record.sessionId) >= 0) ||
      !Number.isSafeInteger(record.messages) ||
      record.messages < 0
    ) {
      return invalidBundle();
    }
    sessionIds.add(record.sessionId);
    previousSessionId = record.sessionId;
    canonicalPortablePath(record.recordPath);
    canonicalPortablePath(record.provenancePath);
    if (
      !record.recordPath.endsWith('.jsonl') ||
      !record.provenancePath.endsWith('.provenance.json') ||
      recordPaths.has(record.recordPath) ||
      provenancePaths.has(record.provenancePath)
    ) {
      return invalidBundle();
    }
    recordPaths.add(record.recordPath);
    provenancePaths.add(record.provenancePath);
  }

  const paths = new Set<string>();
  const portablePaths = new Set<string>();
  let previousPath: string | undefined;
  let totalBytes = 0;
  for (const file of bundle.files) {
    const portable = canonicalPortablePath(file.path);
    if (
      !sessionIds.has(file.sessionId) ||
      (file.kind !== 'record' && file.kind !== 'provenance') ||
      paths.has(file.path) ||
      portablePaths.has(portable) ||
      (previousPath !== undefined && ordinalCompare(previousPath, file.path) >= 0) ||
      typeof file.contents !== 'string' ||
      !isWellFormedUtf16(file.contents) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !HEX64.test(file.contentHash) ||
      Buffer.byteLength(file.contents, 'utf8') !== file.bytes ||
      sha256(file.contents) !== file.contentHash
    ) {
      return invalidBundle();
    }
    paths.add(file.path);
    portablePaths.add(portable);
    previousPath = file.path;
    totalBytes += file.bytes;
  }
  if (totalBytes !== bundle.totalBytes) return invalidBundle();

  for (const record of bundle.records) {
    const recordMatches = bundle.files.filter(
      (file) =>
        file.kind === 'record' &&
        file.sessionId === record.sessionId &&
        file.path === record.recordPath,
    );
    const provenanceMatches = bundle.files.filter(
      (file) =>
        file.kind === 'provenance' &&
        file.sessionId === record.sessionId &&
        file.path === record.provenancePath,
    );
    if (recordMatches.length !== 1 || provenanceMatches.length !== 1) {
      return invalidBundle();
    }
  }
  if (computeContributionContentDigest(bundle.files) !== bundle.contentDigest) {
    return invalidBundle();
  }
  return bundle;
}

export function sameBundleCommitments(
  left: ContributionBundle,
  right: ContributionBundle,
): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.contributorAlias === right.contributorAlias &&
    left.recordCount === right.recordCount &&
    left.totalBytes === right.totalBytes &&
    left.contentDigest === right.contentDigest &&
    left.branch === right.branch &&
    left.commitMessage === right.commitMessage &&
    left.prTitle === right.prTitle &&
    left.prBody === right.prBody &&
    JSON.stringify(left.engine) === JSON.stringify(right.engine) &&
    JSON.stringify(left.records) === JSON.stringify(right.records) &&
    JSON.stringify(
      left.files.map(({ kind, sessionId, path, bytes, contentHash, contents }) => ({
        kind,
        sessionId,
        path,
        bytes,
        contentHash,
        contents,
      })),
    ) ===
      JSON.stringify(
        right.files.map(({ kind, sessionId, path, bytes, contentHash, contents }) => ({
          kind,
          sessionId,
          path,
          bytes,
          contentHash,
          contents,
        })),
      )
  );
}
