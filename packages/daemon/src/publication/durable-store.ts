import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CompiledRulesetSchema } from '@mosga/sanitizer';

import { validateContributionBundle } from './bundle-validator.js';
import { acquireClaimFileLock } from './claim-file-lock.js';
import {
  PUBLICATION_JOURNAL_PHASES,
  PublicationError,
  type PublicationJournal,
  type PublicationReceipt,
  type SealedPublication,
} from './types.js';
import { validatePublicationReceipt } from './receipt.js';
import {
  parseCanonicalRepository,
  parseDatasetManifest,
} from './target.js';

export interface PublicationJournalStore {
  read(publicationRef: string): Promise<PublicationJournal | null>;
  write(journal: PublicationJournal): Promise<PublicationJournal>;
}

export interface PublicationReceiptStore {
  read(publicationRef: string): Promise<PublicationReceipt | null>;
  write(receipt: PublicationReceipt): Promise<PublicationReceipt>;
}

export interface PublicationLock {
  run<T>(action: () => Promise<T>): Promise<T>;
}

function stableError(code: 'workspace_unavailable' | 'publish_in_flight'): PublicationError {
  return new PublicationError({
    code,
    phase: 'workspace',
    message:
      code === 'publish_in_flight'
        ? 'Another publication is already in progress.'
        : 'Publication recovery storage is unavailable.',
    retryable: true,
  });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.promises.rename(temporary, filePath);
  } catch {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw stableError('workspace_unavailable');
  }
}

function safeRef(reference: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(reference)) {
    throw stableError('workspace_unavailable');
  }
  return reference;
}

function parseReceipt(
  raw: unknown,
  expectedPublicationRef: string,
): PublicationReceipt {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !('receipt' in raw) ||
    Object.keys(raw).some((key) => key !== 'schemaVersion' && key !== 'receipt')
  ) {
    throw stableError('workspace_unavailable');
  }
  const receipt = validatePublicationReceipt(
    (raw as { receipt: unknown }).receipt,
  );
  if (receipt.publicationRef !== expectedPublicationRef) {
    throw stableError('workspace_unavailable');
  }
  return receipt;
}

const JOURNAL_COMMON_KEYS = [
  'baseBranch',
  'baseCommitSha',
  'branch',
  'contentDigest',
  'mode',
  'phase',
  'publicationRef',
  'pushRepository',
  'repositoryId',
  'schemaVersion',
  'seal',
  'targetRevision',
  'updatedAt',
  'upstream',
] as const;
const SHA = /^[a-f0-9]{40,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9_-]{1,200}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw stableError('workspace_unavailable');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw stableError('workspace_unavailable');
  }
}

function iso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
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

function validateSeal(
  value: unknown,
  expectedPublicationRef: string,
): SealedPublication {
  const seal = record(value);
  exactKeys(seal, [
    'bundle',
    'compilerOptions',
    'createdAt',
    'expiresAt',
    'publicationRef',
    'reviewIds',
    'reviewSessionIds',
    'ruleset',
    'target',
  ]);
  if (
    seal.publicationRef !== expectedPublicationRef ||
    !iso(seal.createdAt) ||
    !iso(seal.expiresAt) ||
    Date.parse(seal.expiresAt) <= Date.parse(seal.createdAt) ||
    !Array.isArray(seal.reviewIds) ||
    seal.reviewIds.length < 1 ||
    seal.reviewIds.length > 500 ||
    seal.reviewIds.some(
      (reviewId) => typeof reviewId !== 'string' || !SAFE_REF.test(reviewId),
    ) ||
    new Set(seal.reviewIds).size !== seal.reviewIds.length
  ) {
    throw stableError('workspace_unavailable');
  }
  const reviewSessionIds = record(seal.reviewSessionIds);
  if (
    JSON.stringify(Object.keys(reviewSessionIds).sort()) !==
      JSON.stringify([...seal.reviewIds].sort()) ||
    Object.values(reviewSessionIds).some(
      (sessionId) =>
        typeof sessionId !== 'string' ||
        sessionId.length < 1 ||
        sessionId.length > 500,
    )
  ) {
    throw stableError('workspace_unavailable');
  }

  const target = record(seal.target);
  exactKeys(target, [
    'actor',
    'baseCommitSha',
    'defaultBranch',
    'forkProvision',
    'manifest',
    'manifestContentHash',
    'manifestContents',
    'pushRepository',
    'repositoryId',
    'revision',
    'route',
    'upstream',
    'upstreamUrl',
  ]);
  if (
    !Number.isSafeInteger(target.revision) ||
    (target.revision as number) < 0 ||
    typeof target.repositoryId !== 'string' ||
    target.repositoryId.length < 1 ||
    target.repositoryId.length > 500 ||
    !LOGIN.test(String(target.actor)) ||
    (target.route !== 'direct' && target.route !== 'fork') ||
    !['none', 'existing', 'on-submit'].includes(
      String(target.forkProvision),
    ) ||
    !safeBranch(target.defaultBranch) ||
    typeof target.baseCommitSha !== 'string' ||
    !SHA.test(target.baseCommitSha) ||
    typeof target.manifestContentHash !== 'string' ||
    !SHA.test(target.manifestContentHash) ||
    typeof target.manifestContents !== 'string' ||
    Buffer.byteLength(target.manifestContents, 'utf8') > 32 * 1024
  ) {
    throw stableError('workspace_unavailable');
  }
  let upstream;
  let push;
  try {
    upstream = parseCanonicalRepository(target.upstream);
    push = parseCanonicalRepository(target.pushRepository);
    const manifest = parseDatasetManifest(target.manifestContents);
    if (JSON.stringify(manifest) !== JSON.stringify(target.manifest)) {
      throw stableError('workspace_unavailable');
    }
  } catch {
    throw stableError('workspace_unavailable');
  }
  if (
    target.upstreamUrl !== `https://github.com/${upstream.slug}` ||
    (target.route === 'direct' &&
      (push.slug.toLowerCase() !== upstream.slug.toLowerCase() ||
        target.forkProvision !== 'none')) ||
    (target.route === 'fork' &&
      (push.owner.toLowerCase() !== String(target.actor).toLowerCase() ||
        target.forkProvision === 'none'))
  ) {
    throw stableError('workspace_unavailable');
  }

  let bundle;
  try {
    bundle = validateContributionBundle(seal.bundle as never);
  } catch {
    throw stableError('workspace_unavailable');
  }
  const rulesetResult = CompiledRulesetSchema.strict().safeParse(seal.ruleset);
  if (!rulesetResult.success || !iso(rulesetResult.data.generatedAt)) {
    throw stableError('workspace_unavailable');
  }
  const compilerOptions = record(seal.compilerOptions);
  if (
    Object.keys(compilerOptions).some(
      (key) =>
        ![
          'customRules',
          'generatedAt',
          'gitleaksVersion',
          'license',
          'ruleset',
          'sanitizerPackageVersion',
        ].includes(key),
    ) ||
    compilerOptions.ruleset === undefined ||
    JSON.stringify(compilerOptions.ruleset) !== JSON.stringify(seal.ruleset) ||
    !iso(compilerOptions.generatedAt) ||
    typeof compilerOptions.sanitizerPackageVersion !== 'string' ||
    typeof compilerOptions.gitleaksVersion !== 'string' ||
    typeof compilerOptions.license !== 'string' ||
    (compilerOptions.customRules !== undefined &&
      !Array.isArray(compilerOptions.customRules)) ||
    bundle.engine.sanitizerPackageVersion !==
      compilerOptions.sanitizerPackageVersion ||
    bundle.engine.gitleaksVersion !== compilerOptions.gitleaksVersion ||
    bundle.engine.gitleaksVersion !== rulesetResult.data.gitleaksVersion ||
    bundle.engine.rulesetVersion !== rulesetResult.data.rulesetVersion
  ) {
    throw stableError('workspace_unavailable');
  }
  const sealedSessions = new Set(Object.values(reviewSessionIds));
  if (
    sealedSessions.size !== bundle.records.length ||
    bundle.records.some((item) => !sealedSessions.has(item.sessionId))
  ) {
    throw stableError('workspace_unavailable');
  }
  return structuredClone(seal) as unknown as SealedPublication;
}

export function validatePublicationJournal(
  raw: unknown,
  expectedPublicationRef?: string,
): PublicationJournal {
  const journal = record(raw);
  const phase = journal.phase;
  if (
    typeof phase !== 'string' ||
    !PUBLICATION_JOURNAL_PHASES.includes(
      phase as PublicationJournal['phase'],
    )
  ) {
    throw stableError('workspace_unavailable');
  }
  const phaseKeys =
    phase === 'validated'
      ? []
      : phase === 'committed' ||
          phase === 'fork_ready' ||
          phase === 'pushed'
        ? ['commitSha', 'treeSha']
        : phase === 'pr_observed'
          ? ['commitSha', 'prNumber', 'prUrl', 'treeSha']
          : ['commitSha', 'prNumber', 'prUrl', 'receipt', 'treeSha'];
  exactKeys(journal, [...JOURNAL_COMMON_KEYS, ...phaseKeys]);
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.publicationRef !== 'string' ||
    !SAFE_REF.test(journal.publicationRef) ||
    (expectedPublicationRef !== undefined &&
      journal.publicationRef !== expectedPublicationRef) ||
    !Number.isSafeInteger(journal.targetRevision) ||
    (journal.targetRevision as number) < 0 ||
    typeof journal.contentDigest !== 'string' ||
    !HEX64.test(journal.contentDigest) ||
    (journal.mode !== 'direct' && journal.mode !== 'fork') ||
    !safeBranch(journal.baseBranch) ||
    typeof journal.baseCommitSha !== 'string' ||
    !SHA.test(journal.baseCommitSha) ||
    !safeBranch(journal.branch) ||
    typeof journal.repositoryId !== 'string' ||
    journal.repositoryId.length < 1 ||
    journal.repositoryId.length > 500 ||
    !iso(journal.updatedAt)
  ) {
    throw stableError('workspace_unavailable');
  }
  let upstream;
  let push;
  try {
    upstream = parseCanonicalRepository(journal.upstream);
    push = parseCanonicalRepository(journal.pushRepository);
  } catch {
    throw stableError('workspace_unavailable');
  }
  if (
    journal.mode === 'direct' &&
    upstream.slug.toLowerCase() !== push.slug.toLowerCase()
  ) {
    throw stableError('workspace_unavailable');
  }
  const seal = validateSeal(journal.seal, journal.publicationRef);
  if (
    seal.target.revision !== journal.targetRevision ||
    seal.bundle.contentDigest !== journal.contentDigest ||
    seal.target.upstream !== journal.upstream ||
    seal.target.pushRepository !== journal.pushRepository ||
    seal.target.route !== journal.mode ||
    seal.target.defaultBranch !== journal.baseBranch ||
    seal.target.baseCommitSha !== journal.baseCommitSha ||
    seal.target.repositoryId !== journal.repositoryId ||
    seal.bundle.branch !== journal.branch
  ) {
    throw stableError('workspace_unavailable');
  }
  if (phase !== 'validated') {
    if (
      typeof journal.commitSha !== 'string' ||
      !SHA.test(journal.commitSha) ||
      typeof journal.treeSha !== 'string' ||
      !SHA.test(journal.treeSha)
    ) {
      throw stableError('workspace_unavailable');
    }
  }
  if (phase === 'pr_observed' || phase === 'completed') {
    if (
      !Number.isSafeInteger(journal.prNumber) ||
      (journal.prNumber as number) < 1 ||
      journal.prUrl !==
        `https://github.com/${upstream.slug}/pull/${String(journal.prNumber)}`
    ) {
      throw stableError('workspace_unavailable');
    }
  }
  if (phase === 'completed') {
    const receipt = validatePublicationReceipt(journal.receipt);
    if (
      receipt.publicationRef !== journal.publicationRef ||
      receipt.targetRevision !== journal.targetRevision ||
      receipt.contentDigest !== journal.contentDigest ||
      receipt.upstream !== journal.upstream ||
      receipt.pushRepository !== journal.pushRepository ||
      receipt.mode !== journal.mode ||
      receipt.baseBranch !== journal.baseBranch ||
      receipt.baseCommitSha !== journal.baseCommitSha ||
      receipt.branch !== journal.branch ||
      receipt.commitSha !== journal.commitSha ||
      receipt.prNumber !== journal.prNumber ||
      receipt.prUrl !== journal.prUrl ||
      receipt.recordCount !== seal.bundle.recordCount
    ) {
      throw stableError('workspace_unavailable');
    }
  }
  return structuredClone(journal) as unknown as PublicationJournal;
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw stableError('workspace_unavailable');
  }
}

export class FilePublicationJournalStore implements PublicationJournalStore {
  constructor(private readonly directory: string) {}

  async read(publicationRef: string): Promise<PublicationJournal | null> {
    const raw = await readJson(path.join(this.directory, `${safeRef(publicationRef)}.json`));
    return raw === null
      ? null
      : validatePublicationJournal(raw, publicationRef);
  }

  async write(journal: PublicationJournal): Promise<PublicationJournal> {
    const validated = validatePublicationJournal(journal);
    const current = await this.read(validated.publicationRef);
    if (current) {
      const currentIndex = PUBLICATION_JOURNAL_PHASES.indexOf(current.phase);
      const nextIndex = PUBLICATION_JOURNAL_PHASES.indexOf(validated.phase);
      if (nextIndex < currentIndex) throw stableError('workspace_unavailable');
      if (nextIndex === currentIndex) {
        if (JSON.stringify(current) !== JSON.stringify(validated)) {
          throw stableError('workspace_unavailable');
        }
        return current;
      }
      if (nextIndex !== currentIndex + 1) throw stableError('workspace_unavailable');
    } else if (validated.phase !== 'validated') {
      throw stableError('workspace_unavailable');
    }
    await atomicWriteJson(
      path.join(this.directory, `${safeRef(validated.publicationRef)}.json`),
      validated,
    );
    return structuredClone(validated);
  }
}

export class InMemoryPublicationJournalStore implements PublicationJournalStore {
  private readonly values = new Map<string, PublicationJournal>();

  async read(publicationRef: string): Promise<PublicationJournal | null> {
    const value = this.values.get(publicationRef);
    return value ? structuredClone(value) : null;
  }

  async write(journal: PublicationJournal): Promise<PublicationJournal> {
    const validated = validatePublicationJournal(journal);
    const current = await this.read(validated.publicationRef);
    if (current) {
      const currentIndex = PUBLICATION_JOURNAL_PHASES.indexOf(current.phase);
      const nextIndex = PUBLICATION_JOURNAL_PHASES.indexOf(validated.phase);
      if (
        nextIndex < currentIndex ||
        nextIndex > currentIndex + 1 ||
        (nextIndex === currentIndex &&
          JSON.stringify(current) !== JSON.stringify(validated))
      ) {
        throw stableError('workspace_unavailable');
      }
      if (nextIndex === currentIndex) return current;
    } else if (validated.phase !== 'validated') {
      throw stableError('workspace_unavailable');
    }
    this.values.set(validated.publicationRef, structuredClone(validated));
    return structuredClone(validated);
  }
}

export class FilePublicationReceiptStore implements PublicationReceiptStore {
  constructor(private readonly directory: string) {}

  async read(publicationRef: string): Promise<PublicationReceipt | null> {
    const raw = await readJson(path.join(this.directory, `${safeRef(publicationRef)}.json`));
    return raw === null ? null : parseReceipt(raw, publicationRef);
  }

  async write(receipt: PublicationReceipt): Promise<PublicationReceipt> {
    const current = await this.read(receipt.publicationRef);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(receipt)) {
        throw stableError('workspace_unavailable');
      }
      return current;
    }
    await atomicWriteJson(
      path.join(this.directory, `${safeRef(receipt.publicationRef)}.json`),
      { schemaVersion: 1, receipt: validatePublicationReceipt(receipt) },
    );
    return structuredClone(receipt);
  }
}

export class InMemoryPublicationReceiptStore implements PublicationReceiptStore {
  private readonly values = new Map<string, PublicationReceipt>();

  async read(publicationRef: string): Promise<PublicationReceipt | null> {
    const value = this.values.get(publicationRef);
    return value ? structuredClone(value) : null;
  }

  async write(receipt: PublicationReceipt): Promise<PublicationReceipt> {
    validatePublicationReceipt(receipt);
    const current = this.values.get(receipt.publicationRef);
    if (current && JSON.stringify(current) !== JSON.stringify(receipt)) {
      throw stableError('workspace_unavailable');
    }
    if (!current) this.values.set(receipt.publicationRef, structuredClone(receipt));
    return structuredClone(current ?? receipt);
  }
}

export class InMemoryPublicationLock implements PublicationLock {
  private active = false;

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active) throw stableError('publish_in_flight');
    this.active = true;
    try {
      return await action();
    } finally {
      this.active = false;
    }
  }
}

const ACTIVE_FILE_LOCKS = new Set<string>();

export class FilePublicationLock implements PublicationLock {
  constructor(private readonly lockPath: string) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    const lockKey = path.resolve(this.lockPath);
    if (ACTIVE_FILE_LOCKS.has(lockKey)) {
      throw stableError('publish_in_flight');
    }
    ACTIVE_FILE_LOCKS.add(lockKey);
    try {
      const release = await acquireClaimFileLock(lockKey, {
        maxAttempts: 1,
        retryMs: 0,
        busy: () => {
          throw stableError('publish_in_flight');
        },
        unavailable: () => {
          throw stableError('workspace_unavailable');
        },
      });
      try {
        return await action();
      } finally {
        // A failed cleanup leaves only this acquisition's UUID claim. A fresh
        // process can reclaim it after proving this PID has exited.
        await release();
      }
    } finally {
      ACTIVE_FILE_LOCKS.delete(lockKey);
    }
  }
}
