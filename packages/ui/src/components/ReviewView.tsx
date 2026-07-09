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
import { blockingFindings } from '../lib/findings';
import { BatchExitSummary } from './journey/BatchExitSummary';
import { DispositionWorkspace } from './journey/DispositionWorkspace';
import { ExitCards } from './journey/ExitCards';
import { QueueBar } from './journey/QueueBar';
import { SigningCard } from './journey/SigningCard';
import { makeContextLookup } from './NonTextList';
import { Stepper, type JourneyStep } from './shell/Stepper';
import { ConfirmDialog } from './ui/confirm-dialog';
import { WarningsBanner } from './WarningsBanner';

interface ReviewViewProps {
  client: ApiClient;
  /** The review queue. A length-1 queue is the single-session journey (unchanged). */
  items: QueueItem[];
  onRestart?: () => void;
}

/** Per-session journey state; the report/signature are owned here, not the daemon. */
interface ItemState {
  reviewId: string;
  report: SanitizationReport;
  warnings: RulesetWarning[];
  signed: boolean;
  exported: SanitizedSession | null;
}

/**
 * The journey container (steps ②③④), now queue-aware. Owns a per-session state
 * array + a `current` index; ②处置 and ③签署 operate on the current session, and
 * signing item k auto-advances to the next unsigned session. Step ④ becomes
 * enterable only when EVERY session is signed — at which point N=1 renders the
 * existing `ExitCards` (byte-identical to the pre-queue journey) and N>1 renders the
 * transitional `BatchExitSummary`.
 *
 * Signing is client-side state: once a session is signed, ANY disposition change to
 * it is guarded by a `ConfirmDialog` that voids that session's signature and
 * re-locks step ④ (the server gate's 409 remains the final backstop). Leaving the
 * journey with progress in flight is guarded by a second confirm (design Open Q2).
 */
export function ReviewView({ client, items, onRestart }: ReviewViewProps): JSX.Element {
  const [states, setStates] = useState<ItemState[]>(() =>
    items.map((qi) => ({
      reviewId: qi.review.reviewId,
      report: qi.review.report,
      warnings: qi.review.rulesetWarnings,
      signed: false,
      exported: null,
    })),
  );
  const [current, setCurrent] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<JourneyStep>(2);
  const [focusRuleId, setFocusRuleId] = useState<string | null>(null);
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

  const cleared = report.gate.unlocked;
  const pending = report.gate.blockingPending + report.gate.nonTextPending;
  const allSigned = states.every((s) => s.signed);
  // ④ gates on the WHOLE queue being signed (for N=1, allSigned === current signed).
  const maxEnterable: JourneyStep = allSigned ? 4 : cleared ? 3 : 2;

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
      // A report change can re-lock the gate; drop the signature on re-lock, but
      // never re-affirm it — read the latest `s.signed`, not the stale closure, so a
      // just-voided signature (still-unlocked report) is not resurrected.
      setStates((prev) =>
        prev.map((s, i) =>
          i === current ? { ...s, report: next, signed: next.gate.unlocked ? s.signed : false } : s,
        ),
      );
      setTouched(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Guard: when the current session is signed, intercept any disposition change.
  const guarded = (fn: () => Promise<{ report: SanitizationReport }>): void => {
    if (cur.signed) {
      pendingRef.current = fn;
      setConfirmOpen(true);
    } else {
      void runMutation(fn);
    }
  };

  const onConfirmVoid = (): void => {
    patchCurrent({ signed: false });
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

  /** Next unsigned index searching forward from `from` (exclusive), wrapping; -1 if none. */
  const nextUnsigned = (from: number): number => {
    const n = states.length;
    for (let d = 1; d <= n; d++) {
      const idx = (from + d) % n;
      if (idx === from) break;
      // The just-signed `from` item is already accounted for; skip it and any signed.
      if (!states[idx].signed) return idx;
    }
    return -1;
  };

  const onSign = (): void => {
    patchCurrent({ signed: true });
    setTouched(true);
    const next = nextUnsigned(current);
    if (next === -1) {
      setActiveStep(4); // every session signed → the exit step
    } else {
      setCurrent(next);
      setActiveStep(2);
    }
  };

  // The publish wizard's `precheck_refused` view jumps back to step ② and asks the
  // disposition workspace to select the group holding the named rule.
  const onJumpToRule = (ruleId: string): void => {
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

  // Leaving the journey with signed/in-progress work → confirm first (Open Q2).
  const requestRestart = (): void => {
    if (!onRestart) return;
    if (touched || states.some((s) => s.signed)) setRestartOpen(true);
    else onRestart();
  };

  const navigate = (n: JourneyStep): void => {
    if (n === 1) {
      requestRestart();
      return;
    }
    if (n <= maxEnterable) setActiveStep(n);
  };

  const selectItem = (idx: number): void => {
    setCurrent(idx);
    // Per-item view state must not leak across queue items: the previous
    // session's error banner and precheck rule focus are meaningless here.
    // The clamp effect trims the active step to the picked item's enterable max.
    setError(null);
    setFocusRuleId(null);
  };

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
            pick another session
          </button>
        )}
      </header>

      {isMulti && (
        <QueueBar
          items={items}
          current={current}
          signed={states.map((s) => s.signed)}
          onSelect={selectItem}
        />
      )}

      <Stepper
        current={currentStep}
        cleared={cleared}
        signed={allSigned}
        completed={completed}
        pending={pending}
      />

      {/* Steps are clickable to navigate (enterable ones only); ① restarts. */}
      <nav className="flex gap-1 text-xs" data-testid="step-nav">
        {([1, 2, 3, 4] as JourneyStep[]).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => navigate(n)}
            disabled={n !== 1 && n > maxEnterable}
            data-testid={`goto-step-${n}`}
            className="rounded px-2 py-1 text-text-muted enabled:hover:text-foreground disabled:opacity-40"
          >
            {n === 1 ? '① 换会话' : n === 2 ? '② 处置' : n === 3 ? '③ 签署' : '④ 出口'}
          </button>
        ))}
      </nav>

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
          />
        )}
        {currentStep === 3 && <SigningCard report={report} onSign={onSign} />}
        {currentStep === 4 &&
          (isMulti ? (
            <BatchExitSummary client={client} items={items} />
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
            />
          ))}
      </main>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="作废签署并重新锁定出口"
        description="修改处置将作废你已完成的签署，出口将重新锁定，需要重新签署。"
        confirmLabel="作废并修改"
        cancelLabel="取消"
        onConfirm={onConfirmVoid}
      />

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        testid="restart-confirm"
        title="放弃当前队列？"
        description="返回选择会话将丢弃本次队列的处置与签署进度，需要重新开始。"
        confirmLabel="放弃并返回"
        cancelLabel="继续审阅"
        onConfirm={() => onRestart?.()}
      />
    </div>
  );
}
