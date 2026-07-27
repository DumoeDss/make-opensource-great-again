import {
  ContributionBundleRefusedError,
  type ContributionRefusal,
} from '@mosga/publisher';

import { PublicationError } from './types.js';

interface RefusalAttribution {
  reviewId: string;
  sessionId: string;
  blockingByRule: Record<string, number>;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Convert the publisher's safe aggregate refusal into the one stable
 * publication error used by both preview and confirmed-submit recompilation.
 * No finding previews, exact bytes, paths, or exception text cross this seam.
 */
export function mapContributionBundleRefusal(
  error: unknown,
  reviewBySession: ReadonlyMap<string, string>,
): PublicationError | null {
  if (!(error instanceof ContributionBundleRefusedError)) return null;

  const combined = new Map<string, RefusalAttribution>();
  for (const refusal of error.refusals) {
    mergeRefusal(combined, refusal, reviewBySession);
  }
  const refusals = [...combined.values()].sort(
    (left, right) =>
      ordinal(left.reviewId, right.reviewId) ||
      ordinal(left.sessionId, right.sessionId),
  );
  return new PublicationError({
    code: 'precheck_refused',
    phase: 'preview',
    message: 'Publication pre-check refused one or more selected reviews.',
    retryable: false,
    refusals,
  });
}

function mergeRefusal(
  combined: Map<string, RefusalAttribution>,
  refusal: ContributionRefusal,
  reviewBySession: ReadonlyMap<string, string>,
): void {
  const reviewId = reviewBySession.get(refusal.sessionId) ?? 'unknown';
  const key = `${reviewId}\u0000${refusal.sessionId}`;
  const current = combined.get(key) ?? {
    reviewId,
    sessionId: refusal.sessionId,
    blockingByRule: {},
  };
  for (const [ruleId, count] of Object.entries(refusal.blockingByRule).sort(
    ([left], [right]) => ordinal(left, right),
  )) {
    if (!Number.isSafeInteger(count) || count < 1) continue;
    current.blockingByRule[ruleId] =
      (current.blockingByRule[ruleId] ?? 0) + count;
  }
  combined.set(key, current);
}
