/**
 * Stateful review store (design D1). `POST /api/reviews` runs the pipeline once
 * and stores `{ session, report, mapper }` keyed by a generated `reviewId`;
 * every later route mutates the held `report` (via the sanitizer's pure
 * report-transform helpers) and reads the held `mapper` at export.
 *
 * Holding the mapper server-side is the load-bearing reason this is stateful:
 * `applyDispositions` needs the SAME `PseudonymMapper` instance
 * (`primaryContributorAlias()` + placeholder consistency), and the mapper's
 * internal counters do not cleanly serialize to the browser and back. State is
 * in-memory only and lost on restart (a re-scan is deterministic, so a review
 * can be redone without corruption — documented in the README threat model).
 */
import { randomUUID } from 'node:crypto';

import type { SanitizedSession } from '@mosga/contracts';
import {
  type CompiledRuleset,
  type PseudonymMapper,
  type RulesetWarning,
  type SanitizationReport,
  type ScanOptions,
  scanSession,
} from '@mosga/sanitizer';

import type { ReplayReviewState, ReviewSourceRef } from './replayReview.js';

export interface ReviewState {
  session: SanitizedSession;
  report: SanitizationReport;
  mapper: PseudonymMapper;
  rulesetWarnings: RulesetWarning[];
  /**
   * The source-session ref held at review creation so `/replay/prepare` can call
   * `adapter.captureNativeSession(ref)` without re-deriving the enumeration.
   * Absent on reviews created before this field was added (the prepare route
   * fails closed with a stable error in that case).
   */
  source?: ReviewSourceRef;
  /**
   * The parallel replay review state (native-capture → draft → scan → seal).
   * Produced by `/replay/prepare`; consumed by the replay disposition endpoints
   * and `/replay/seal`. Distinct from the normalized `report`/`mapper` above.
   */
  replay?: ReplayReviewState;
}

/**
 * Default cap on concurrent in-memory reviews before LRU eviction. Raised to 500
 * to support large batch queues (the picker no longer caps the selection); the LRU
 * still bounds memory, it just sits far above any realistic single batch.
 */
export const DEFAULT_MAX_REVIEWS = 500;

export class ReviewStore {
  // Insertion order in a Map is iteration order, so the first key is the LRU
  // entry; `touch()` re-inserts on access to keep active reviews warm.
  private readonly reviews = new Map<string, ReviewState>();
  private readonly maxReviews: number;

  constructor(maxReviews: number = DEFAULT_MAX_REVIEWS) {
    this.maxReviews = Math.max(1, maxReviews);
  }

  /**
   * Scan a session and store the resulting review state; returns the id. The
   * optional `source` holds the source-session ref so `/replay/prepare` can call
   * `adapter.captureNativeSession(ref)` later without re-deriving the enumeration.
   */
  create(
    session: SanitizedSession,
    ruleset: CompiledRuleset,
    options: ScanOptions = {},
    source?: ReviewSourceRef,
  ): { reviewId: string; state: ReviewState } {
    const { report, mapper, rulesetWarnings } = scanSession(session, ruleset, options);
    const reviewId = randomUUID();
    const state: ReviewState = { session, report, mapper, rulesetWarnings, source };
    this.reviews.set(reviewId, state);
    this.evict();
    return { reviewId, state };
  }

  get(reviewId: string): ReviewState | undefined {
    const state = this.reviews.get(reviewId);
    if (state) this.touch(reviewId, state);
    return state;
  }

  /**
   * Replace the held report after a disposition edit (pure transforms).
   * Concurrent disposition requests are last-write-wins: two in-flight edits
   * both read the same base report and the later `setReport` overwrites the
   * earlier. This can only DROP an edit (the gate then stays MORE locked, never
   * falsely unlocked — `/export` re-derives the gate at call time), so it is
   * safe for single-user v0.1; a rapid double-action may transiently desync the
   * displayed counts until the next fetch.
   */
  setReport(reviewId: string, report: SanitizationReport): void {
    const state = this.reviews.get(reviewId);
    if (state) {
      state.report = report;
      this.touch(reviewId, state);
    }
  }

  /**
   * Store the replay review state produced by `/replay/prepare`. Holds the
   * exact `PseudonymMapper` + `CompiledRuleset` returned/used by the scan so
   * `/replay/seal` can pass the matching pair to `applyReplayDispositions`.
   */
  setReplay(reviewId: string, replay: ReplayReviewState): void {
    const state = this.reviews.get(reviewId);
    if (state) {
      state.replay = replay;
      this.touch(reviewId, state);
    }
  }

  /** Get the replay review state (or undefined when no preparation has run). */
  getReplay(reviewId: string): ReplayReviewState | undefined {
    const state = this.reviews.get(reviewId);
    if (state) {
      this.touch(reviewId, state);
      return state.replay;
    }
    return undefined;
  }

  /**
   * Replace the held replay report after a disposition edit (pure transforms).
   * Same last-write-wins discipline as `setReport`: concurrent disposition
   * requests can only DROP an edit (the gate then stays MORE locked).
   */
  setReplayReport(reviewId: string, report: ReplayReviewState['report']): void {
    const state = this.reviews.get(reviewId);
    if (state?.replay) {
      state.replay.report = report;
      this.touch(reviewId, state);
    }
  }

  /** Store the sealed bundle produced by `/replay/seal`. */
  setSealedBundle(reviewId: string, bundle: ReplayReviewState['sealedBundle']): void {
    const state = this.reviews.get(reviewId);
    if (state?.replay) {
      state.replay.sealedBundle = bundle;
      this.touch(reviewId, state);
    }
  }

  has(reviewId: string): boolean {
    return this.reviews.has(reviewId);
  }

  get size(): number {
    return this.reviews.size;
  }

  /** Move an accessed entry to the most-recently-used end. */
  private touch(reviewId: string, state: ReviewState): void {
    this.reviews.delete(reviewId);
    this.reviews.set(reviewId, state);
  }

  /** Drop least-recently-used entries until under the cap. */
  private evict(): void {
    while (this.reviews.size > this.maxReviews) {
      const oldest = this.reviews.keys().next().value;
      if (oldest === undefined) break;
      this.reviews.delete(oldest);
    }
  }
}
