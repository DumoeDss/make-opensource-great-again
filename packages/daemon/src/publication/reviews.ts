import type { SanitizedSession } from '@mosga/contracts';
import { applyDispositions } from '@mosga/sanitizer';

import type { ReviewStore } from '../reviews.js';
import { PublicationError } from './types.js';

export interface SelectedPublicationReview {
  reviewId: string;
  sessionId: string;
  session: SanitizedSession;
}
export function selectPublicationReviews(
  reviewIds: unknown,
  store: ReviewStore,
): SelectedPublicationReview[] {
  if (
    !Array.isArray(reviewIds) ||
    reviewIds.length === 0 ||
    reviewIds.length > 500 ||
    reviewIds.some(
      (id) =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 200 ||
        id.trim() !== id,
    )
  ) {
    throw new PublicationError({
      code: 'review_not_found',
      phase: 'preview',
      message: 'Select between 1 and 500 valid reviews.',
      retryable: false,
    });
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of reviewIds as string[]) {
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }

  return deduped.map((reviewId) => {
    const state = store.get(reviewId);
    if (!state) {
      throw new PublicationError({
        code: 'review_not_found',
        phase: 'preview',
        message: 'A selected review was not found.',
        retryable: false,
        reviewId,
      });
    }
    const applied = applyDispositions(state.session, state.report, state.mapper);
    if (!applied.gate.unlocked) {
      throw new PublicationError({
        code: 'GATE_LOCKED',
        phase: 'preview',
        message: 'A selected review is still locked.',
        retryable: false,
        reviewId,
        gate: applied.gate,
      });
    }
    return {
      reviewId,
      sessionId: applied.session.session.sessionId,
      session: applied.session,
    };
  });
}
