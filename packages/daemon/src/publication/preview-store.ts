import {
  PublicationError,
  type PublicationPreview,
  type SealedPublication,
} from './types.js';

export interface SealedPreviewStore {
  put(input: Omit<SealedPublication, 'publicationRef' | 'createdAt' | 'expiresAt'>): SealedPublication;
  get(publicationRef: string): SealedPublication;
  invalidateTargetRevision(revision: number): void;
  delete(publicationRef: string): void;
  project(seal: SealedPublication): PublicationPreview;
}
export interface PreviewStoreOptions {
  id?: () => string;
  now?: () => Date;
  ttlMs?: number;
  capacity?: number;
}

export const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_PREVIEW_CAPACITY = 100;

export class InMemorySealedPreviewStore implements SealedPreviewStore {
  private readonly seals = new Map<string, SealedPublication>();
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly expiredRefs = new Map<string, number>();

  constructor(options: PreviewStoreOptions = {}) {
    this.id = options.id ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_PREVIEW_CAPACITY);
  }

  put(
    input: Omit<SealedPublication, 'publicationRef' | 'createdAt' | 'expiresAt'>,
  ): SealedPublication {
    this.evictExpired();
    const now = this.now();
    const seal: SealedPublication = {
      ...input,
      publicationRef: this.id(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.seals.set(seal.publicationRef, seal);
    while (this.seals.size > this.capacity) {
      const oldest = this.seals.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seals.delete(oldest);
    }
    return seal;
  }

  get(publicationRef: string): SealedPublication {
    const seal = this.seals.get(publicationRef);
    if (seal && this.now().getTime() >= Date.parse(seal.expiresAt)) {
      this.seals.delete(publicationRef);
      this.expiredRefs.set(publicationRef, this.now().getTime());
      this.trimExpiredRefs();
      throw new PublicationError({
        code: 'preview_expired',
        phase: 'preview',
        message: 'This publication preview has expired. Create a new preview.',
        retryable: false,
      });
    }
    if (!seal) {
      if (this.expiredRefs.has(publicationRef)) {
        throw new PublicationError({
          code: 'preview_expired',
          phase: 'preview',
          message: 'This publication preview has expired. Create a new preview.',
          retryable: false,
        });
      }
      throw new PublicationError({
        code: 'preview_not_found',
        phase: 'preview',
        message: 'Publication preview not found. Create a new preview.',
        retryable: false,
      });
    }
    return seal;
  }

  invalidateTargetRevision(revision: number): void {
    for (const [reference, seal] of this.seals) {
      if (seal.target.revision === revision) this.seals.delete(reference);
    }
  }

  delete(publicationRef: string): void {
    this.seals.delete(publicationRef);
  }

  project(seal: SealedPublication): PublicationPreview {
    return {
      publicationRef: seal.publicationRef,
      expiresAt: seal.expiresAt,
      target: {
        repositoryId: seal.target.repositoryId,
        revision: seal.target.revision,
        upstream: seal.target.upstream,
        pushRepository: seal.target.pushRepository,
        route: seal.target.route,
        forkProvision: seal.target.forkProvision,
        baseBranch: seal.target.defaultBranch,
        baseCommitSha: seal.target.baseCommitSha,
        willCreateFork: seal.target.forkProvision === 'on-submit',
      },
      contribution: {
        contractVersion: seal.bundle.contractVersion,
        contentDigest: seal.bundle.contentDigest,
        branch: seal.bundle.branch,
        commitMessage: seal.bundle.commitMessage,
        prTitle: seal.bundle.prTitle,
        prBody: seal.bundle.prBody,
        recordCount: seal.bundle.recordCount,
        totalBytes: seal.bundle.totalBytes,
        files: seal.bundle.files.map(({ kind, path, bytes, contentHash }) => ({
          kind,
          path,
          bytes,
          contentHash,
        })),
        engine: { ...seal.bundle.engine },
      },
    };
  }

  private evictExpired(): void {
    const now = this.now().getTime();
    for (const [reference, seal] of this.seals) {
      if (now >= Date.parse(seal.expiresAt)) {
        this.seals.delete(reference);
        this.expiredRefs.set(reference, now);
      }
    }
    this.trimExpiredRefs();
  }

  private trimExpiredRefs(): void {
    while (this.expiredRefs.size > this.capacity) {
      const oldest = this.expiredRefs.keys().next().value as string | undefined;
      if (!oldest) break;
      this.expiredRefs.delete(oldest);
    }
  }
}
