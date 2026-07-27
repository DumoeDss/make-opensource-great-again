import {
  compileContributionBundle,
  resolveSanitizerPackageVersion,
  type ContributionBundle,
  type ContributionBundleOptions,
} from '@mosga/publisher';
import type { CompiledRuleset } from '@mosga/sanitizer';

import type { ReviewStore } from '../reviews.js';
import { validateContributionBundle } from './bundle-validator.js';
import {
  inspectCompatibleTarget,
  resolveGitHubTarget,
  type GitHubPort,
} from './github/index.js';
import type { SealedPreviewStore } from './preview-store.js';
import { mapContributionBundleRefusal } from './precheck-refusal.js';
import { selectPublicationReviews } from './reviews.js';
import {
  assertManifestAccepts,
  parseCanonicalRepository,
} from './target.js';
import type { PublicationTargetStore } from './target-store.js';
import {
  PublicationError,
  type GitHubPublication,
  type PublicationIssue,
  type PublicationPreview,
  type PublicationReceipt,
  type PublicationStatus,
} from './types.js';

export interface GitHubPublicationServiceOptions {
  targetStore: PublicationTargetStore;
  previews: SealedPreviewStore;
  github: GitHubPort;
  reviews: ReviewStore;
  ruleset: CompiledRuleset;
  compilerOptions?: Omit<ContributionBundleOptions, 'ruleset' | 'license'>;
  compile?: typeof compileContributionBundle;
  submit?: (input: {
    publicationRef: string;
    targetRevision: number;
    contentDigest: string;
    confirmPublic: true;
  }) => Promise<PublicationReceipt>;
}

function issueFrom(error: PublicationError): PublicationIssue {
  const code =
    error.body.code === 'target_store_unavailable'
      ? 'target_store_unavailable'
      : error.body.code === 'target_not_found'
        ? 'target_not_found'
        : error.body.code === 'target_incompatible'
          ? 'target_incompatible'
          : error.body.code === 'github_client_missing'
            ? 'github_client_missing'
            : error.body.code === 'permission_denied'
              ? 'permission_denied'
              : error.body.code === 'fork_failed'
                ? 'fork_failed'
                : 'github_unavailable';
  return {
    code,
    message: error.body.message,
    retryable: error.body.retryable,
    recovery: error.body.recovery,
  };
}

export class GitHubPublicationService implements GitHubPublication {
  private readonly compile: typeof compileContributionBundle;

  constructor(private readonly options: GitHubPublicationServiceOptions) {
    this.compile = options.compile ?? compileContributionBundle;
  }

  async inspect(): Promise<PublicationStatus> {
    let target;
    try {
      target = await this.options.targetStore.read();
    } catch (error) {
      const publicationError =
        error instanceof PublicationError
          ? error
          : new PublicationError({
              code: 'target_store_unavailable',
              phase: 'target',
              message: 'Publication target configuration is unavailable.',
              retryable: true,
            });
      return {
        state: 'blocked',
        revision: 0,
        issues: [issueFrom(publicationError)],
      };
    }
    if (!target.upstream) return { state: 'unconfigured', revision: target.revision };
    try {
      const resolved = await resolveGitHubTarget(target, this.options.github);
      if (resolved.snapshot.forkProvision === 'on-submit') {
        return {
          state: 'fork_confirmation_required',
          revision: target.revision,
          target: resolved.summary,
          actor: resolved.snapshot.actor,
          pushRepository: resolved.snapshot.pushRepository,
        };
      }
      return {
        state: 'ready',
        revision: target.revision,
        target: resolved.summary,
        actor: resolved.snapshot.actor,
        route: resolved.snapshot.route,
        pushRepository: resolved.snapshot.pushRepository,
        willCreateFork: false,
      };
    } catch (error) {
      if (
        error instanceof PublicationError &&
        error.body.code === 'github_login_required'
      ) {
        try {
          const compatible = await inspectCompatibleTarget(target, this.options.github);
          return {
            state: 'login_required',
            revision: target.revision,
            target: compatible.summary,
          };
        } catch {
          // Return the original stable login state only when safe target facts
          // can be obtained; otherwise fall through to a blocked issue.
        }
      }
      const publicationError =
        error instanceof PublicationError
          ? error
          : new PublicationError({
              code: 'github_unavailable',
              phase: 'target',
              message: 'GitHub is temporarily unavailable.',
              retryable: true,
            });
      return {
        state: 'blocked',
        revision: target.revision,
        issues: [issueFrom(publicationError)],
      };
    }
  }

  async configure(input: { repository: string }): Promise<PublicationStatus> {
    const canonical = parseCanonicalRepository(input.repository);
    const before = await this.options.targetStore.read();
    const after = await this.options.targetStore.configure({
      owner: canonical.owner,
      repo: canonical.repo,
    });
    if (after.revision !== before.revision) {
      this.options.previews.invalidateTargetRevision(before.revision);
    }
    return this.inspect();
  }

  async clear(): Promise<PublicationStatus> {
    const before = await this.options.targetStore.read();
    const after = await this.options.targetStore.clear();
    if (after.revision !== before.revision) {
      this.options.previews.invalidateTargetRevision(before.revision);
    }
    return this.inspect();
  }

  async preview(input: { reviewIds: string[] }): Promise<PublicationPreview> {
    const selected = selectPublicationReviews(input.reviewIds, this.options.reviews);
    const target = await this.options.targetStore.read();
    const resolved = await resolveGitHubTarget(target, this.options.github);
    assertManifestAccepts(
      resolved.snapshot.manifest,
      selected.map((item) => item.session.schemaVersion),
    );
    const compilerOptions: ContributionBundleOptions = {
      ...this.options.compilerOptions,
      ruleset: this.options.ruleset,
      sanitizerPackageVersion:
        this.options.compilerOptions?.sanitizerPackageVersion ??
        resolveSanitizerPackageVersion(),
      gitleaksVersion:
        this.options.compilerOptions?.gitleaksVersion ??
        this.options.ruleset.gitleaksVersion,
      license: resolved.snapshot.manifest.license,
    };
    let bundle: ContributionBundle;
    try {
      bundle = this.compile(
        selected.map((item) => item.session),
        compilerOptions,
      );
    } catch (error) {
      const mapped = mapContributionBundleRefusal(
        error,
        new Map(selected.map((item) => [item.sessionId, item.reviewId])),
      );
      if (mapped) throw mapped;
      throw error;
    }
    validateContributionBundle(bundle);
    const seal = this.options.previews.put({
      reviewIds: selected.map((item) => item.reviewId),
      reviewSessionIds: Object.fromEntries(
        selected.map((item) => [item.reviewId, item.sessionId]),
      ),
      target: resolved.snapshot,
      bundle,
      compilerOptions,
      ruleset: this.options.ruleset,
    });
    return this.options.previews.project(seal);
  }

  async submit(input: {
    publicationRef: string;
    targetRevision: number;
    contentDigest: string;
    confirmPublic: true;
  }): Promise<PublicationReceipt> {
    if (this.options.submit) return this.options.submit(input);
    throw new PublicationError({
      code: 'preview_not_found',
      phase: 'preview',
      message: 'Publication delivery is unavailable.',
      retryable: false,
    });
  }
}
