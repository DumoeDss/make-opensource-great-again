import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  Disposition,
  NonTextDisposition,
  NormalizationCategory,
  QueueItem,
  RulesetWarning,
  SanitizationReport,
  SanitizedSession,
} from '../api/types';
import { blockingFindings, cleanableFindings, distinctRuleIds } from '../lib/findings';
import { AffirmDialog } from './journey/AffirmDialog';
import { BatchExitCards } from './journey/BatchExitCards';
import { DispositionWorkspace } from './journey/DispositionWorkspace';
import { ExitCards } from './journey/ExitCards';
import { QueueBar } from './journey/QueueBar';
import { makeContextLookup } from './NonTextList';
import { Stepper, type JourneyStep } from './shell/Stepper';
import { ConfirmDialog } from './ui/confirm-dialog';
import { WarningsBanner } from './WarningsBanner';

interface ReviewViewProps {
  client: ApiClient;
  /** The review queue. A length-1 queue is the single-session journey. */
  items: QueueItem[];
  onRestart?: () => void;
}

/** Per-session journey state; the held report is authoritative for the gate counts. */
interface ItemState {
  reviewId: string;
  report: SanitizationReport;
  warnings: RulesetWarning[];
  exported: SanitizedSession | null;
}

/**
 * The journey container, now a 3-step flow: ②处置命中 → ③选择出口, with donation
 * confirmation collapsed into ONE dialog raised before the first exit action
 * (`AffirmDialog`) — the user's ask: confirm once for the whole queue, not per
 * session. Shortest path is 一键替换 → 选择出口 → 确认.
 *
 * `affirmed` is client-side; the server's per-review gate 409 stays the final
 * backstop, and each 出口② consent is still content-bound. Editing any disposition
 * after affirming voids the affirmation via a `ConfirmDialog`. Leaving the journey
 * with progress prompts a second confirm.
 */
export function ReviewView({ client, items, onRestart }: ReviewViewProps): JSX.Element {
  const [states, setStates] = useState<ItemState[]>(() =>
    items.map((qi) => ({
      reviewId: qi.review.reviewId,
      report: qi.review.report,
      warnings: qi.review.rulesetWarnings,
      exported: null,
    })),
  );
  const [current, setCurrent] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<JourneyStep>(2);
  const [focusRuleId, setFocusRuleId] = useState<string | null>(null);
  // The whole-queue donation confirmation, and the exit action awaiting it.
  const [affirmed, setAffirmed] = useState(false);
  const [affirmOpen, setAffirmOpen] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  // The disposition-void confirm (fired when editing after affirming).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  // "Touched" once any disposition succeeds — arms the leave-journey confirm.
  const [touched, setTouched] = useState(false);
  const pendingRef = useRef<(() => Promise<{ report: SanitizationReport }>) | null>(null);

  const cur = states[current];
  const report = cur.report;
  const isMulti = states.length > 1;

  const blocking = useMemo(() => blockingFindings(report), [report]);
  const contextFor = useMemo(() => makeContextLookup(report.findings), [report.findings]);

  const cleared = report.gate.unlocked; // the CURRENT session
  const allCleared = states.every((s) => s.report.gate.unlocked);
  // ③ 选择出口 is enterable once EVERY session's gate is unlocked.
  const maxEnterable: JourneyStep = allCleared ? 3 : 2;

  // Triage + clean derivations (single source: `cleanableFindings`).
  const pendingPerItem = states.map((s) => s.report.gate.blockingPending + s.report.gate.nonTextPending);
  const pendingTotal = pendingPerItem.reduce((a, b) => a + b, 0);
  const currentCleanable = cleanableFindings(cur.report).length;
  const queueCleanableCount = states.reduce((n, s) => n + cleanableFindings(s.report).length, 0);

  // Clamp back if a re-lock/void/queue-switch removed access to a later step.
  useEffect(() => {
    if (activeStep > maxEnterable) setActiveStep(maxEnterable);
  }, [activeStep, maxEnterable]);

  const currentStep = activeStep;

  /** Patch just the current session's state. */
  const patchCurrent = (patch: Partial<ItemState>): void => {
    setStates((prev) => prev.map((s, i) => (i === current ? { ...s, ...patch } : s)));
  };

  const runMutation = async (fn: () => Promise<{ report: SanitizationReport }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { report: next } = await fn();
      setStates((prev) => prev.map((s, i) => (i === current ? { ...s, report: next } : s)));
      setTouched(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Guard: once the queue is affirmed, intercept any disposition change with a
  // void-confirm (editing invalidates the whole-queue confirmation).
  const guarded = (fn: () => Promise<{ report: SanitizationReport }>): void => {
    if (affirmed) {
      pendingRef.current = fn;
      setConfirmOpen(true);
    } else {
      void runMutation(fn);
    }
  };

  const onConfirmVoid = (): void => {
    setAffirmed(false);
    setCompleted(false);
    const fn = pendingRef.current;
    pendingRef.current = null;
    if (fn) void runMutation(fn);
  };

  const onDisposition = (findingId: string, d: Disposition): void => {
    guarded(() => client.setDisposition(cur.reviewId, findingId, d));
  };
  const onBatchByRule = (ruleId: string, d: Disposition): void => {
    guarded(() => client.batch(cur.reviewId, 'rule', ruleId, d));
  };
  const onBatchByType = (category: NormalizationCategory, d: Disposition): void => {
    guarded(() => client.batch(cur.reviewId, 'type', category, d));
  };
  const onNonText = (messageUuid: string, d: NonTextDisposition): void => {
    guarded(() => client.setNonText(cur.reviewId, messageUuid, d));
  };

  // ---- One-time donation confirmation ----------------------------------------
  // The first exit action opens the AffirmDialog; on confirm we run the deferred
  // action. Once affirmed, exits proceed directly (until an edit voids it).
  const requireAffirm = (proceed: () => void): void => {
    if (affirmed) {
      proceed();
      return;
    }
    pendingActionRef.current = proceed;
    setAffirmOpen(true);
  };

  const onAffirmConfirm = (): void => {
    setAffirmed(true);
    const fn = pendingActionRef.current;
    pendingActionRef.current = null;
    if (fn) fn();
  };

  // The publish wizard's `precheck_refused` view jumps back to step ② and asks the
  // disposition workspace to select the group holding the named rule.
  const onJumpToRule = (ruleId: string): void => {
    setFocusRuleId(ruleId);
    setActiveStep(2);
  };

  // The BATCH wizard's per-session refusal jumps to that session's step ②.
  const onJumpToSession = (reviewId: string, ruleId: string): void => {
    const idx = states.findIndex((s) => s.reviewId === reviewId);
    if (idx === -1) return;
    selectItem(idx);
    setFocusRuleId(ruleId);
    setActiveStep(2);
  };

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.exportReview(cur.reviewId);
      if (result.ok) {
        patchCurrent({ exported: result.data.session });
      } else {
        setError('Export refused: gate is locked.');
        patchCurrent({ report: { ...cur.report, gate: result.gate } });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- One-click clean (no-pressure donation) --------------------------------
  // Replace every cleanable hit (pending + blocking + NON-meta) in a session, by
  // rule. Meta/engine hits (ruleset-compile-error / redos-guard) and non-text items
  // are deliberately NOT auto-disposed — an engine degradation or an image must be
  // seen by a human. The cleanable count (the affordance) and this action share
  // `cleanableFindings`, so they can never drift.
  const runClean = async (item: ItemState): Promise<SanitizationReport | null> => {
    const ruleIds = distinctRuleIds(cleanableFindings(item.report));
    if (ruleIds.length === 0) return null;
    let latest = item.report;
    for (const ruleId of ruleIds) {
      const { report: next } = await client.batch(item.reviewId, 'rule', ruleId, 'replace');
      latest = next;
    }
    return latest;
  };

  const applyCleaned = (reviewId: string, latest: SanitizationReport): void => {
    setStates((prev) => prev.map((s) => (s.reviewId === reviewId ? { ...s, report: latest } : s)));
    setTouched(true);
  };

  /** Next session index (from `from`, wrapping) whose pending count is > 0; -1 if none. */
  const findNextPending = (pend: number[], from: number): number => {
    const n = pend.length;
    for (let d = 1; d <= n; d++) {
      const idx = (from + d) % n;
      if (idx === from) break;
      if (pend[idx] > 0) return idx;
    }
    return -1;
  };

  /** Clean the given session, then auto-advance (next pending session, or → 选择出口). */
  const cleanSession = async (idx: number): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const item = states[idx];
      const latest = await runClean(item);
      if (latest) applyCleaned(item.reviewId, latest);
      const clearedNow = (latest ?? item.report).gate.unlocked;
      if (clearedNow) {
        // Pending across the queue, with `idx` overridden by the just-cleaned report.
        const pend = states.map((s, i) => {
          const rep = i === idx ? (latest ?? s.report) : s.report;
          return rep.gate.blockingPending + rep.gate.nonTextPending;
        });
        const nextIdx = findNextPending(pend, idx);
        if (nextIdx === -1) {
          setActiveStep(3); // whole queue cleared → choose an exit
        } else {
          setCurrent(nextIdx);
          setActiveStep(2);
          setError(null);
          setFocusRuleId(null);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Clean every session sequentially; failures accumulate but never stop the loop. */
  const cleanQueue = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    const updated = new Map<string, SanitizationReport>();
    for (const item of states) {
      try {
        const latest = await runClean(item);
        if (latest) {
          applyCleaned(item.reviewId, latest);
          updated.set(item.reviewId, latest);
        }
      } catch (e) {
        failures.push(`${item.reviewId}: ${String(e)}`);
      }
    }
    setBusy(false);
    if (failures.length > 0) setError(`部分会话清洗失败：${failures.join('；')}`);
    // Auto-advance to 选择出口 once the whole queue is cleared.
    const allClearedNow = states.every((s) => (updated.get(s.reviewId) ?? s.report).gate.unlocked);
    if (allClearedNow) setActiveStep(3);
  };

  // The ② cleared banner's CTA: to 选择出口 when the whole queue is done, otherwise
  // move on to the next session that still needs work.
  const onProceedToExit = (): void => {
    if (allCleared) {
      setActiveStep(3);
      return;
    }
    const next = findNextPending(pendingPerItem, current);
    if (next !== -1) selectItem(next);
  };

  // Leaving the journey with progress → confirm first.
  const requestRestart = (): void => {
    if (!onRestart) return;
    if (touched || affirmed) setRestartOpen(true);
    else onRestart();
  };

  // The Stepper only navigates ②③ (① is non-interactive; 换会话 lives in the header).
  const navigate = (n: JourneyStep): void => {
    if (n <= maxEnterable) setActiveStep(n);
  };

  const selectItem = (idx: number): void => {
    setCurrent(idx);
    // Per-item view state must not leak across queue items.
    setError(null);
    setFocusRuleId(null);
  };

  const batchItems = states.map((s, i) => ({
    reviewId: s.reviewId,
    sessionId: s.report.sessionId,
    title: items[i].ref.title ?? s.report.sessionId,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review · {report.sessionId}</h1>
        {onRestart && (
          <button
            type="button"
            onClick={requestRestart}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            data-testid="restart"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
            换会话
          </button>
        )}
      </header>

      {isMulti && (
        <QueueBar
          items={items}
          current={current}
          pending={pendingPerItem}
          onSelect={selectItem}
          queueCleanableCount={queueCleanableCount}
          onCleanQueue={() => void cleanQueue()}
          busy={busy}
        />
      )}

      <Stepper
        current={currentStep}
        cleared={allCleared}
        completed={completed}
        pending={pendingTotal}
        maxEnterable={maxEnterable}
        onNavigate={navigate}
      />

      <WarningsBanner warnings={cur.warnings} />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <main>
        {currentStep === 2 && (
          <DispositionWorkspace
            report={report}
            blocking={blocking}
            nonTextItems={report.nonTextItems}
            contextFor={contextFor}
            onDisposition={onDisposition}
            onBatchByRule={onBatchByRule}
            onBatchByType={onBatchByType}
            onNonText={onNonText}
            busy={busy}
            focusRuleId={focusRuleId}
            cleanableCount={currentCleanable}
            onCleanAll={() => void cleanSession(current)}
            cleared={cleared}
            onProceedToExit={onProceedToExit}
          />
        )}
        {currentStep === 3 &&
          (isMulti ? (
            <BatchExitCards
              client={client}
              items={batchItems}
              onPublished={() => setCompleted(true)}
              onSubmittedAll={() => setCompleted(true)}
              onJumpToSession={onJumpToSession}
              requireAffirm={requireAffirm}
            />
          ) : (
            <ExitCards
              client={client}
              reviewId={cur.reviewId}
              gate={report.gate}
              exported={cur.exported}
              exporting={busy}
              onExport={() => void onExport()}
              onSubmitted={() => setCompleted(true)}
              onPublished={() => setCompleted(true)}
              onJumpToRule={onJumpToRule}
              requireAffirm={requireAffirm}
            />
          ))}
      </main>

      <AffirmDialog
        open={affirmOpen}
        onOpenChange={(o) => {
          setAffirmOpen(o);
          if (!o) pendingActionRef.current = null;
        }}
        reports={states.map((s) => s.report)}
        onConfirm={onAffirmConfirm}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="作废捐赠确认并重新锁定出口"
        description="修改处置将作废你已完成的捐赠确认，出口将重新锁定，需要重新确认。"
        confirmLabel="作废并修改"
        cancelLabel="取消"
        onConfirm={onConfirmVoid}
      />

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        testid="restart-confirm"
        title="放弃当前队列？"
        description="返回选择会话将丢弃本次队列的处置进度，需要重新开始。"
        confirmLabel="放弃并返回"
        cancelLabel="继续审阅"
        onConfirm={() => onRestart?.()}
      />
    </div>
  );
}
