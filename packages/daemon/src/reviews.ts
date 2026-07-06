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

export interface ReviewState {
  session: SanitizedSession;
  report: SanitizationReport;
  mapper: PseudonymMapper;
  rulesetWarnings: RulesetWarning[];
}

/** Default cap on concurrent in-memory reviews before LRU eviction. */
export const DEFAULT_MAX_REVIEWS = 50;

export class ReviewStore {
  // Insertion order in a Map is iteration order, so the first key is the LRU
  // entry; `touch()` re-inserts on access to keep active reviews warm.
  private readonly reviews = new Map<string, ReviewState>();
  private readonly maxReviews: number;

  constructor(maxReviews: number = DEFAULT_MAX_REVIEWS) {
    this.maxReviews = Math.max(1, maxReviews);
  }

  /** Scan a session and store the resulting review state; returns the id. */
  create(
    session: SanitizedSession,
    ruleset: CompiledRuleset,
    options: ScanOptions = {},
  ): { reviewId: string; state: ReviewState } {
    const { report, mapper, rulesetWarnings } = scanSession(session, ruleset, options);
    const reviewId = randomUUID();
    const state: ReviewState = { session, report, mapper, rulesetWarnings };
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
