import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  Disposition,
  NonTextDisposition,
  NormalizationCategory,
  RulesetWarning,
  SanitizationReport,
  SanitizedSession,
} from '../api/types';
import { blockingFindings } from '../lib/findings';
import { DispositionWorkspace } from './journey/DispositionWorkspace';
import { ExitCards } from './journey/ExitCards';
import { SigningCard } from './journey/SigningCard';
import { makeContextLookup } from './NonTextList';
import { Stepper, type JourneyStep } from './shell/Stepper';
import { ConfirmDialog } from './ui/confirm-dialog';
import { WarningsBanner } from './WarningsBanner';

interface ReviewViewProps {
  client: ApiClient;
  reviewId: string;
  initialReport: SanitizationReport;
  warnings: RulesetWarning[];
  onRestart?: () => void;
}

/**
 * The journey container (steps ②③④). Owns `report`/`signed`/`busy`/`error`/
 * `exported`/`completed`, derives the current step + lock-badge state, and renders
 * the persistent `Stepper` + the active step (② `DispositionWorkspace` /
 * ③ `SigningCard` / ④ `ExitCards`). Every mutation still goes through the daemon
 * and refreshes the held report so gate counts stay authoritative.
 *
 * Signing is client-side state: once signed, ANY disposition change is guarded by
 * a `ConfirmDialog` that voids the signature and re-locks step ④ (the server
 * gate's 409 remains the final backstop). Unsigned disposition runs directly.
 */
export function ReviewView({
  client,
  reviewId,
  initialReport,
  warnings,
  onRestart,
}: ReviewViewProps): JSX.Element {
  const [report, setReport] = useState<SanitizationReport>(initialReport);
  const [signed, setSigned] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<SanitizedSession | null>(null);
  const [activeStep, setActiveStep] = useState<JourneyStep>(2);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<(() => Promise<{ report: SanitizationReport }>) | null>(null);

  const blocking = useMemo(() => blockingFindings(report), [report]);
  const contextFor = useMemo(() => makeContextLookup(report.findings), [report.findings]);

  const cleared = report.gate.unlocked;
  const pending = report.gate.blockingPending + report.gate.nonTextPending;
  const maxEnterable: JourneyStep = signed ? 4 : cleared ? 3 : 2;

  // Clamp back if a re-lock/void removed access to a later step the user was on.
  useEffect(() => {
    if (activeStep > maxEnterable) setActiveStep(maxEnterable);
  }, [activeStep, maxEnterable]);

  const currentStep = activeStep;

  const runMutation = async (fn: () => Promise<{ report: SanitizationReport }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { report: next } = await fn();
      setReport(next);
      // A report change can re-lock the gate; drop a stale signature (backstop).
      if (!next.gate.unlocked) setSigned(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Guard: when signed, intercept any disposition change with a void-confirm.
  const guarded = (fn: () => Promise<{ report: SanitizationReport }>): void => {
    if (signed) {
      pendingRef.current = fn;
      setConfirmOpen(true);
    } else {
      void runMutation(fn);
    }
  };

  const onConfirmVoid = (): void => {
    setSigned(false);
    setCompleted(false);
    const fn = pendingRef.current;
    pendingRef.current = null;
    if (fn) void runMutation(fn);
  };

  const onDisposition = (findingId: string, d: Disposition): void => {
    guarded(() => client.setDisposition(reviewId, findingId, d));
  };
  const onBatchByRule = (ruleId: string, d: Disposition): void => {
    guarded(() => client.batch(reviewId, 'rule', ruleId, d));
  };
  const onBatchByType = (category: NormalizationCategory, d: Disposition): void => {
    guarded(() => client.batch(reviewId, 'type', category, d));
  };
  const onNonText = (messageUuid: string, d: NonTextDisposition): void => {
    guarded(() => client.setNonText(reviewId, messageUuid, d));
  };

  const onSign = (): void => {
    setSigned(true);
    setActiveStep(4);
  };

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.exportReview(reviewId);
      if (result.ok) {
        setExported(result.data.session);
      } else {
        setError('Export refused: gate is locked.');
        setReport((r) => ({ ...r, gate: result.gate }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const navigate = (n: JourneyStep): void => {
    if (n === 1) {
      onRestart?.();
      return;
    }
    if (n <= maxEnterable) setActiveStep(n);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review · {report.sessionId}</h1>
        {onRestart && (
          <button
            type="button"
            onClick={onRestart}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            data-testid="restart"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
            pick another session
          </button>
        )}
      </header>

      <Stepper
        current={currentStep}
        cleared={cleared}
        signed={signed}
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

      <WarningsBanner warnings={warnings} />

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
          />
        )}
        {currentStep === 3 && <SigningCard report={report} onSign={onSign} />}
        {currentStep === 4 && (
          <ExitCards
            client={client}
            reviewId={reviewId}
            gate={report.gate}
            exported={exported}
            exporting={busy}
            onExport={() => void onExport()}
            onSubmitted={() => setCompleted(true)}
          />
        )}
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
    </div>
  );
}
