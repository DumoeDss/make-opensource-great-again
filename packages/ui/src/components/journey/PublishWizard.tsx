/**
 * PublishWizard — the step-④ 出口① three-step publish flow (design B4), rendered
 * inline (not a modal) so the journey stepper stays visible:
 *
 *   ① 预检   — POST publish/plan; pending + timeout states; on `precheck_refused`
 *             show the rule-aggregated blocked reasons + a jump back to the
 *             step-② group for the named rule (no raw values ever shown).
 *   ② PR 预览 — prTitle + prBody (styled <pre>, per Open Question 3 — no markdown
 *             renderer), the staged file list, the branch, and compareUrl.
 *   ③ 提交    — writes to disk (publish/stage). When gh is available AND
 *             authenticated, a one-click publish/submit (push + open PR);
 *             otherwise the staged locations + the exact `plan.commands` (the
 *             last is `gh pr create`) + the `git push`/compareUrl browser
 *             fallback + per-command copy buttons.
 *
 * A successful submit calls `onPublished()` so ReviewView marks step ④ 已完成.
 */
import { ArrowLeft, Check, ClipboardCopy, ExternalLink, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { PublishError, PublishPlan } from '../../api/types';
import i18n from '../../lib/i18n';
import { Button } from '../ui/button';

interface PublishWizardProps {
  client: ApiClient;
  reviewId: string;
  /** True only when gh is present AND authenticated (from preflight) — enables one-click. */
  ghReady: boolean;
  /** Marks step ④ 已完成 in the journey container on a successful submit. */
  onPublished: () => void;
  /** Jump back to step ② and select the group holding this rule. */
  onJumpToRule: (ruleId: string) => void;
}

type Step = 'precheck' | 'preview' | 'submit';

/** How long a plan may run before the wizard shows the (non-fatal) slow notice. */
const PLAN_TIMEOUT_MS = 12_000;

export function PublishWizard({
  client,
  reviewId,
  ghReady,
  onPublished,
  onJumpToRule,
}: PublishWizardProps): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('precheck');
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [slow, setSlow] = useState(false);
  const [refused, setRefused] = useState<PublishError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [staging, setStaging] = useState(false);
  const [staged, setStaged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState(false);

  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const runPrecheck = useCallback(async () => {
    setPlanning(true);
    setSlow(false);
    setRefused(null);
    setError(null);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlow(true), PLAN_TIMEOUT_MS);
    try {
      const res = await client.publishPlan(reviewId);
      if (res.ok) {
        setPlan(res.plan);
        setStep('preview');
      } else if (res.code === 'precheck_refused') {
        setRefused(res);
      } else {
        setError(res.error || res.code);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (slowTimer.current) clearTimeout(slowTimer.current);
      setPlanning(false);
      setSlow(false);
    }
  }, [client, reviewId]);

  // Kick off the pre-check when the wizard mounts.
  useEffect(() => {
    void runPrecheck();
    return () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [runPrecheck]);

  const doStage = async (): Promise<boolean> => {
    setStaging(true);
    setError(null);
    try {
      const res = await client.publishStage(reviewId);
      if (res.ok) {
        setStaged(true);
        return true;
      }
      setError(publishErrorText(res));
      return false;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setStaging(false);
    }
  };

  const doSubmit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await client.publishSubmit(reviewId);
      if (res.ok) {
        setStaged(true);
        setPublished(true);
        onPublished();
      } else {
        setError(publishErrorText(res));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="publish-wizard">
      <WizardSteps step={step} />

      {error && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
          data-testid="wizard-error"
        >
          {error}
        </div>
      )}

      {step === 'precheck' && (
        <div data-testid="wizard-step-precheck" className="space-y-3">
          {planning && (
            <p className="flex items-center gap-2 text-sm text-text-muted" data-testid="precheck-pending">
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
              {t('publish.precheckPending')}
            </p>
          )}
          {slow && (
            <div
              className="rounded-md border border-warning/50 bg-warning/10 p-2 text-sm"
              data-testid="precheck-timeout"
            >
              {t('publish.precheckSlow')}
              <button type="button" className="ml-1 text-primary underline" onClick={() => void runPrecheck()}>
                {t('publish.precheckRetry')}
              </button>
              {t('publish.precheckSlowSuffix')}
            </div>
          )}
          {refused && (
            <div
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              data-testid="precheck-refused"
            >
              <p className="font-medium text-destructive">{t('publish.precheckRefused')}</p>
              <ul className="space-y-1">
                {(refused.blockingByRule ?? []).map((b) => (
                  <li key={b.ruleId} className="flex items-center justify-between gap-2">
                    <span>
                      {t('publish.rulePrefix')}<code className="font-mono">{b.ruleId}</code>{t('publish.ruleSuffix', { count: b.count })}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="subtle"
                      onClick={() => onJumpToRule(b.ruleId)}
                      data-testid={`jump-to-rule-${b.ruleId}`}
                    >
                      <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {t('publish.jumpToRule')}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button type="button" size="sm" variant="secondary" onClick={() => void runPrecheck()}>
                {t('publish.precheckRetry')}
              </Button>
            </div>
          )}
        </div>
      )}

      {step === 'preview' && plan && (
        <div data-testid="wizard-step-preview" className="space-y-3">
          <div className="rounded-md border border-border bg-surface-1 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{t('publish.branch')}</span>
              <span className="font-mono" data-testid="preview-branch">
                {plan.branch}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-text-muted">{t('publish.targetBranch')}</span>
              <span className="font-mono">{plan.targetBranch}</span>
            </div>
            <div className="mt-1">
              <span className="text-text-muted">{t('publish.stagedFiles')}</span>
              <ul className="mt-1 font-mono text-xs text-text-subtle" data-testid="preview-staged-files">
                {plan.stagedFiles.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            {plan.compareUrl && (
              <div className="mt-2">
                <a
                  href={plan.compareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                  data-testid="preview-compare-link"
                >
                  <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t('publish.compareLink')}
                </a>
              </div>
            )}
          </div>

          <div>
            <p className="mb-1 text-sm font-medium">{plan.prTitle}</p>
            <pre
              className="max-h-80 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs text-text-muted"
              data-testid="preview-pr-body"
            >
              {plan.prBody}
            </pre>
          </div>

          <Button type="button" onClick={() => setStep('submit')} data-testid="wizard-to-submit">
            {t('publish.nextStep')}
          </Button>
        </div>
      )}

      {step === 'submit' && plan && (
        <div data-testid="wizard-step-submit" className="space-y-3">
          {published ? (
            <div
              className="flex items-center gap-2 rounded-md border border-success/50 bg-success/10 p-3 text-sm text-success"
              data-testid="published-badge"
            >
              <Check className="h-4 w-4" strokeWidth={1.5} />
              {t('publish.publishedBadgePrefix')}<code className="font-mono">{plan.branch}</code>{t('publish.publishedBadgeSuffix')}
            </div>
          ) : ghReady ? (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                {t('publish.ghReady')}
              </p>
              <Button
                type="button"
                size="lg"
                disabled={submitting}
                onClick={() => void doSubmit()}
                data-testid="wizard-submit-btn"
              >
                {submitting ? t('publish.submitting') : t('publish.submitBtn')}
              </Button>
            </div>
          ) : !staged ? (
            <div className="space-y-2">
              <p className="text-sm text-text-muted">
                {t('publish.ghUnavailable')}
              </p>
              <Button
                type="button"
                size="lg"
                disabled={staging}
                onClick={() => void doStage()}
                data-testid="wizard-stage-btn"
              >
                {staging ? t('publish.staging') : t('publish.stageBtn')}
              </Button>
            </div>
          ) : (
            <ManualFallback plan={plan} />
          )}
        </div>
      )}
    </div>
  );
}

/** The gh-free path: staged file locations + copyable commands + compare fallback. */
function ManualFallback({ plan }: { plan: PublishPlan }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="manual-fallback">
      <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm" data-testid="staged-locations">
        <p className="font-medium text-success">{t('publish.stagedTitle')}</p>
        <ul className="mt-1 font-mono text-xs text-text-muted">
          {plan.stagedFiles.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-text-subtle">
          {t('publish.stagedBranchPrefix')}<code className="font-mono">{plan.branch}</code>
        </p>
      </div>

      <div className="space-y-1" data-testid="manual-commands">
        <p className="text-sm text-text-muted">{t('publish.manualCommandsPrefix')}<code>gh pr create</code>{t('publish.manualCommandsSuffix')}</p>
        {plan.commands.map((cmd, i) => (
          <div
            key={cmd}
            className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1"
          >
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs">{cmd}</code>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('publish.copyCommand')}
              data-testid={`copy-cmd-${i}`}
              onClick={() => void copyText(cmd)}
            >
              <ClipboardCopy className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}
      </div>

      {plan.compareUrl && (
        <p className="text-sm">
          {t('publish.manualCompare')}{' '}
          <a
            href={plan.compareUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
            data-testid="manual-compare-link"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            {t('publish.manualComparePage')}
          </a>{' '}
          {t('publish.manualCompareSuffix')}
        </p>
      )}
    </div>
  );
}

const STEP_LABELS: Array<{ id: Step; label: string }> = [
  { id: 'precheck', label: 'publish.stepPrecheck' },
  { id: 'preview', label: 'publish.stepPreview' },
  { id: 'submit', label: 'publish.stepSubmit' },
];

function WizardSteps({ step }: { step: Step }): JSX.Element {
  const { t } = useTranslation();
  const order: Step[] = ['precheck', 'preview', 'submit'];
  const activeIdx = order.indexOf(step);
  return (
    <ol className="flex gap-2 text-xs" data-testid="wizard-steps">
      {STEP_LABELS.map((s, i) => (
        <li
          key={s.id}
          aria-current={s.id === step ? 'step' : undefined}
          className={
            i === activeIdx
              ? 'font-medium text-foreground'
              : i < activeIdx
                ? 'text-success'
                : 'text-text-subtle'
          }
        >
          {t(s.label)}
        </li>
      ))}
    </ol>
  );
}

function publishErrorText(err: PublishError): string {
  if (err.code === 'branch_exists' && err.branch) {
    return i18n.t('publish.branchError', { error: err.error, branch: err.branch });
  }
  return err.error || err.code;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard is best-effort; the command is visible + selectable regardless.
  }
}
