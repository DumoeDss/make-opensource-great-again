import {
  compileContributionBundle,
  precheckRecord,
  scanRawBytesBackstop,
  type ContributionBundle,
} from '@mosga/publisher';
import type { CompiledRuleset, Finding } from '@mosga/sanitizer';
import { z } from 'zod';

import type { ReviewStore } from '../reviews.js';
import {
  sameBundleCommitments,
  validateContributionBundle,
} from './bundle-validator.js';
import type { PublicationReceiptStore } from './durable-store.js';
import { resolveGitHubTarget, type GitHubPort } from './github/index.js';
import type { SealedPreviewStore } from './preview-store.js';
import { mapContributionBundleRefusal } from './precheck-refusal.js';
import { validatePublicationReceipt } from './receipt.js';
import { selectPublicationReviews } from './reviews.js';
import type { PublicationTargetStore } from './target-store.js';
import {
  PublicationError,
  type PublicationReceipt,
  type SealedPublication,
  type TargetSnapshot,
} from './types.js';

const StrictSubmitInput = z
  .object({
    publicationRef: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    targetRevision: z.number().int().nonnegative().safe(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmPublic: z.literal(true),
  })
  .strict();

export interface SubmitPreflightDependencies {
  receipts: PublicationReceiptStore;
  previews: SealedPreviewStore;
  targets: PublicationTargetStore;
  reviews: ReviewStore;
  github: GitHubPort;
  currentRuleset: () => CompiledRuleset;
  compile?: typeof compileContributionBundle;
}

export interface ValidatedSubmission {
  kind: 'validated';
  seal: SealedPublication;
  bundle: ContributionBundle;
  target: TargetSnapshot;
}

export interface ExistingSubmission {
  kind: 'receipt';
  receipt: PublicationReceipt;
}

export type SubmitPreflightResult = ValidatedSubmission | ExistingSubmission;

function stale(message = 'The publication preview is stale. Create a new preview.'): never {
  throw new PublicationError({
    code: 'preview_stale',
    phase: 'preview',
    message,
    retryable: false,
  });
}

function aggregate(findings: readonly Finding[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function exactTargetEqual(left: TargetSnapshot, right: TargetSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SubmitPreflight {
  private readonly compile: typeof compileContributionBundle;

  constructor(private readonly dependencies: SubmitPreflightDependencies) {
    this.compile = dependencies.compile ?? compileContributionBundle;
  }

  async validate(input: unknown): Promise<SubmitPreflightResult> {
    const parsed = StrictSubmitInput.safeParse(input);
    if (!parsed.success) {
      throw new PublicationError({
        code: 'preview_stale',
        phase: 'preview',
        message: 'The confirmed publication request is invalid.',
        retryable: false,
      });
    }
    const request = parsed.data;

    // Read-only idempotency lookup is first. Durable writes begin only in the
    // state machine after this complete method returns successfully.
    const receipt = await this.dependencies.receipts.read(request.publicationRef);
    if (receipt) {
      const validatedReceipt = validatePublicationReceipt(receipt);
      if (
        validatedReceipt.targetRevision !== request.targetRevision ||
        validatedReceipt.contentDigest !== request.contentDigest
      ) {
        return stale();
      }
      return { kind: 'receipt', receipt: validatedReceipt };
    }

    const seal = this.dependencies.previews.get(request.publicationRef);
    if (seal.publicationRef !== request.publicationRef) return stale();
    if (
      seal.target.revision !== request.targetRevision ||
      seal.bundle.contentDigest !== request.contentDigest
    ) {
      return stale();
    }

    const storedTarget = await this.dependencies.targets.read();
    if (storedTarget.revision !== seal.target.revision) {
      throw new PublicationError({
        code: 'target_changed',
        phase: 'preview',
        message: 'The publication target changed. Create a new preview.',
        retryable: false,
      });
    }

    const selected = selectPublicationReviews(
      seal.reviewIds,
      this.dependencies.reviews,
    );
    if (
      selected.length !== seal.reviewIds.length ||
      selected.some(
        (item) => seal.reviewSessionIds[item.reviewId] !== item.sessionId,
      )
    ) {
      return stale();
    }

    const currentRuleset = this.dependencies.currentRuleset();
    let currentBundle: ContributionBundle;
    try {
      currentBundle = this.compile(
        selected.map((item) => item.session),
        {
          ...seal.compilerOptions,
          ruleset: currentRuleset,
        },
      );
    } catch (error) {
      const mapped = mapContributionBundleRefusal(
        error,
        new Map(selected.map((item) => [item.sessionId, item.reviewId])),
      );
      if (mapped) throw mapped;
      throw error;
    }
    validateContributionBundle(currentBundle);
    if (!sameBundleCommitments(seal.bundle, currentBundle)) return stale();

    const currentTarget = (
      await resolveGitHubTarget(storedTarget, this.dependencies.github)
    ).snapshot;
    if (!exactTargetEqual(seal.target, currentTarget)) {
      return stale();
    }

    validateContributionBundle(seal.bundle);
    this.finalExactByteGate(seal, currentRuleset);
    return {
      kind: 'validated',
      seal,
      bundle: seal.bundle,
      target: seal.target,
    };
  }

  private finalExactByteGate(
    seal: SealedPublication,
    currentRuleset: CompiledRuleset,
  ): void {
    const reviewBySession = new Map(
      Object.entries(seal.reviewSessionIds).map(([reviewId, sessionId]) => [
        sessionId,
        reviewId,
      ]),
    );
    const refusals: Array<{
      reviewId: string;
      sessionId: string;
      blockingByRule: Record<string, number>;
    }> = [];
    for (const file of seal.bundle.files) {
      const findings =
        file.kind === 'record'
          ? precheckRecord(file.contents, {
              ruleset: currentRuleset,
              sanitizerPackageVersion:
                seal.bundle.engine.sanitizerPackageVersion,
              generatedAt: seal.compilerOptions.generatedAt,
            }).blockingFindings
          : scanRawBytesBackstop(
              file.contents,
              currentRuleset,
              seal.compilerOptions.generatedAt,
            );
      if (findings.length > 0) {
        refusals.push({
          reviewId: reviewBySession.get(file.sessionId) ?? 'unknown',
          sessionId: file.sessionId,
          blockingByRule: aggregate(findings),
        });
      }
    }
    if (refusals.length > 0) {
      refusals.sort((left, right) =>
        left.reviewId < right.reviewId
          ? -1
          : left.reviewId > right.reviewId
            ? 1
            : left.sessionId < right.sessionId
              ? -1
              : 1,
      );
      throw new PublicationError({
        code: 'precheck_refused',
        phase: 'preview',
        message: 'Publication pre-check refused one or more selected reviews.',
        retryable: false,
        refusals,
      });
    }
  }
}
