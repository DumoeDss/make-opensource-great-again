/**
 * Replay review state + pure report-transform helpers.
 *
 * The replay preparation flow runs alongside the existing normalized review
 * (design §9): both use the same compiled ruleset, but the replay path scans
 * native JSONL rows + instruction content via the sanitizer's `scanReplayDraft`
 * / `applyReplayDispositions` APIs. This module holds the replay review state
 * that lives next to the normalized `ReviewState` and the pure helpers that
 * mutate the replay report after a disposition edit.
 *
 * State is in-memory only and lost on restart (same discipline as the
 * normalized review). The `PseudonymMapper` instance is held server-side for the
 * same load-bearing reason: `applyReplayDispositions` needs the SAME mapper
 * returned by the matching `scanReplayDraft`, never one from a separate run.
 */
import type { CliSessionRef, ReplayBundle, ReplayBundleDraft, ReplayDeliveryTarget } from '@mosga/contracts';
import { computeReplayGate } from '@mosga/sanitizer';
import type {
  CompiledRuleset,
  PseudonymMapper,
  ReplayFinding,
  ReplayFindingDisposition,
  ReplayOpaqueDisposition,
  ReplayOpaqueItem,
  ReplaySanitizationReport,
  RulesetWarning,
} from '@mosga/sanitizer';

/**
 * The replay review state held next to the normalized `ReviewState`. Produced
 * by `/replay/prepare`; consumed by the disposition endpoints and `/replay/seal`.
 *
 * `ruleset` and `mapper` are held server-side (never sent over HTTP): apply
 * independently binds draft id, canonical draft-content hash, expected ruleset
 * version, compiled ruleset, terminal-seed provenance, report, and replay-scoped
 * pseudonym mapper — never combine a draft/report/mapper from separate runs.
 */
export interface ReplayReviewState {
  /** The replay bundle draft (immutable source of truth for the scan). */
  readonly draft: ReplayBundleDraft;
  /** The live replay report (mutated by disposition edits). */
  report: ReplaySanitizationReport;
  /** The exact mapper returned by `scanReplayDraft` for this draft. */
  readonly mapper: PseudonymMapper;
  /** The exact compiled ruleset used for the scan (re-used at apply). */
  readonly ruleset: CompiledRuleset;
  /** Caller-held ruleset identity (binds the report to this ruleset version). */
  readonly rulesetVersion: string;
  /** Report version bound into the terminal-manifest seed's provenance. */
  readonly reportVersion: string;
  /** The user-chosen delivery target sealed into the seed. */
  readonly delivery: ReplayDeliveryTarget;
  /** Ruleset warnings from the initial scan. */
  readonly rulesetWarnings: RulesetWarning[];
  /** Set after `/replay/seal`; consumed by the cli-resume submit route. */
  sealedBundle?: ReplayBundle;
}

/**
 * The source-session ref held at review creation so `/replay/prepare` can call
 * `adapter.captureNativeSession(ref)` without re-deriving the enumeration.
 */
export interface ReviewSourceRef {
  readonly sourceId: string;
  readonly ref: CliSessionRef;
}

/**
 * Set a single replay finding's disposition (pure transform). Returns a new
 * report; the original is untouched. Mirrors the normalized-review
 * `setFindingDisposition` discipline. The blocking/pending gate is recomputed.
 */
export function setReplayFindingDisposition(
  report: ReplaySanitizationReport,
  findingId: string,
  disposition: ReplayFindingDisposition,
): ReplaySanitizationReport {
  const findings = report.findings.map((finding) =>
    finding.id === findingId ? ({ ...finding, disposition } as ReplayFinding) : finding,
  );
  return recomputeReplayGate({ ...report, findings });
}

/**
 * Set a single replay opaque item's disposition (pure transform). A `replace`
 * decision requires an explicit JSON replacement; any other decision clears it.
 */
export function setReplayOpaqueDisposition(
  report: ReplaySanitizationReport,
  itemId: string,
  disposition: ReplayOpaqueDisposition,
  replacement: unknown,
): ReplaySanitizationReport {
  const opaqueItems = report.opaqueItems.map((item) =>
    item.id === itemId
      ? ({
          ...item,
          disposition,
          replacement: disposition === 'replace' ? (replacement as ReplayOpaqueItem['replacement']) : null,
        } as ReplayOpaqueItem)
      : item,
  );
  return recomputeReplayGate({ ...report, opaqueItems });
}

/** Recompute the replay gate from the current findings + opaque items. */
export function recomputeReplayGate(report: ReplaySanitizationReport): ReplaySanitizationReport {
  const gate = computeReplayGate(report.findings, report.opaqueItems);
  return { ...report, gate };
}
