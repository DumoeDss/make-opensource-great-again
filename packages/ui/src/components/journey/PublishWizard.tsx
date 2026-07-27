import { ArrowLeft, Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import type {
  PublicationErrorBody,
  PublicationPreview,
  PublicationReceipt,
  PublicationStatus,
} from '../../api/types';
import { AdvancedFold } from '../ui/advanced-fold';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface PublishWizardProps {
  client: ApiClient;
  reviewIds: string[];
  onPublished: (receipt: PublicationReceipt) => void;
  onJumpToReviewIssue: (reviewId: string, ruleId?: string) => void;
  onRefreshStatus: () => Promise<PublicationStatus | null>;
}

type Machine =
  | { kind: 'previewing' }
  | { kind: 'preview_ready'; preview: PublicationPreview }
  | { kind: 'confirming'; preview: PublicationPreview }
  | { kind: 'submitting'; preview: PublicationPreview }
  | { kind: 'succeeded'; preview: PublicationPreview; receipt: PublicationReceipt }
  | { kind: 'retryable_error'; preview: PublicationPreview; error: PublicationErrorBody }
  | { kind: 're_preview'; error: PublicationErrorBody | null; canPreview: boolean }
  | { kind: 'refused'; error: PublicationErrorBody }
  | { kind: 'error'; error: PublicationErrorBody };

const PREVIEW_SLOW_MS = 12_000;
const FRESHNESS_CODES = new Set([
  'preview_not_found',
  'preview_expired',
  'preview_stale',
  'target_changed',
]);

export function PublishWizard({
  client,
  reviewIds,
  onPublished,
  onJumpToReviewIssue,
  onRefreshStatus,
}: PublishWizardProps): JSX.Element {
  const [machine, setMachine] = useState<Machine>({ kind: 'previewing' });
  const [slow, setSlow] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const reviewSelectionKey = reviewIds.join('\u0000');

  const startPreview = useCallback(async (): Promise<void> => {
    setMachine({ kind: 'previewing' });
    setSlow(false);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlow(true), PREVIEW_SLOW_MS);
    const result = await client.previewPublication(reviewIds);
    if (slowTimer.current) clearTimeout(slowTimer.current);
    slowTimer.current = null;
    setSlow(false);
    if (result.ok) {
      setClock(Date.now());
      setMachine({ kind: 'preview_ready', preview: result.data });
      return;
    }
    if (result.error.code === 'precheck_refused') {
      setMachine({ kind: 'refused', error: result.error });
    } else {
      setMachine({ kind: 'error', error: result.error });
    }
  }, [client, reviewSelectionKey]);

  useEffect(() => {
    void startPreview();
    return () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, [startPreview]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const activePreview =
    machine.kind === 'preview_ready' ||
    machine.kind === 'confirming' ||
    machine.kind === 'submitting' ||
    machine.kind === 'succeeded' ||
    machine.kind === 'retryable_error'
      ? machine.preview
      : null;
  const locallyExpired =
    activePreview !== null && clock >= Date.parse(activePreview.expiresAt);

  const openConfirmation = (): void => {
    if (!activePreview) return;
    if (locallyExpired) {
      setMachine({
        kind: 're_preview',
        canPreview: true,
        error: {
          code: 'preview_expired',
          phase: 'preview',
          message: 'This publication preview has expired.',
          retryable: false,
          recovery: 'Create a new preview and review its public effects.',
        },
      });
      return;
    }
    setMachine({ kind: 'confirming', preview: activePreview });
  };

  const submit = async (preview: PublicationPreview): Promise<void> => {
    setMachine({ kind: 'submitting', preview });
    const result = await client.submitPublication({
      publicationRef: preview.publicationRef,
      targetRevision: preview.target.revision,
      contentDigest: preview.contribution.contentDigest,
      confirmPublic: true,
    });
    if (result.ok) {
      if (!receiptMatchesPreview(result.data, preview)) {
        setMachine({
          kind: 'retryable_error',
          preview,
          error: receiptBindingError(),
        });
        return;
      }
      setMachine({ kind: 'succeeded', preview, receipt: result.data });
      onPublished(result.data);
      return;
    }
    const { error } = result;
    if (FRESHNESS_CODES.has(error.code)) {
      const refreshed = await onRefreshStatus();
      setMachine({
        kind: 're_preview',
        error,
        canPreview: isPreviewableStatus(refreshed),
      });
      return;
    }
    if (error.code === 'review_not_found' || error.code === 'GATE_LOCKED') {
      setMachine({ kind: 'error', error });
      return;
    }
    if (error.code === 'precheck_refused') {
      setMachine({ kind: 'refused', error });
      return;
    }
    if (error.retryable) {
      setMachine({ kind: 'retryable_error', preview, error });
      return;
    }
    const refreshed = await onRefreshStatus();
    setMachine({
      kind: 're_preview',
      error,
      canPreview: isPreviewableStatus(refreshed),
    });
  };

  return (
    <div className="min-w-0 space-y-4" data-testid="publish-wizard">
      <WizardSteps machine={machine} />

      {machine.kind === 'previewing' && (
        <section
          aria-live="polite"
          className="space-y-3"
          data-testid="wizard-step-previewing"
        >
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            Preparing a read-only safety and pull-request preview for{' '}
            {reviewIds.length} reviewed {reviewIds.length === 1 ? 'session' : 'sessions'}…
          </p>
          {slow && (
            <p className="rounded-md border border-warning/50 bg-warning/10 p-2 text-sm">
              Preview is taking longer than expected. The daemon is still working; no
              repository write has started.
            </p>
          )}
        </section>
      )}

      {machine.kind === 'refused' && (
        <RefusalView
          error={machine.error}
          onJump={onJumpToReviewIssue}
          onRetry={() => void startPreview()}
        />
      )}

      {machine.kind === 'error' && (
        <ErrorView
          error={machine.error}
          onJump={onJumpToReviewIssue}
          action={
            <Button type="button" size="sm" variant="secondary" onClick={() => void startPreview()}>
              Retry preview
            </Button>
          }
        />
      )}

      {machine.kind === 're_preview' && (
        <section
          className="space-y-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
          role="alert"
          data-testid="wizard-repreview"
        >
          <p className="font-medium">
            {machine.error?.message ?? 'A new publication preview is required.'}
          </p>
          {machine.error?.recovery && (
            <p className="break-words text-text-muted">{machine.error.recovery}</p>
          )}
          <p className="text-text-muted">
            The previous sealed snapshot was discarded. Review and confirm a new
            preview; it will not be submitted automatically.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={!machine.canPreview}
            onClick={() => void startPreview()}
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.5} />
            Create new preview
          </Button>
          {!machine.canPreview && (
            <p className="text-text-muted">
              Publication is not currently ready. Resolve the refreshed target status
              before creating another preview.
            </p>
          )}
        </section>
      )}

      {activePreview && machine.kind !== 'succeeded' && (
        <PreviewSummary preview={activePreview} locallyExpired={locallyExpired} />
      )}

      {machine.kind === 'preview_ready' && (
        <div className="space-y-2">
          {locallyExpired ? (
            <div role="alert" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              This preview has expired locally. Create a new preview before confirming.
            </div>
          ) : null}
          <Button
            ref={confirmationTriggerRef}
            type="button"
            size="lg"
            disabled={locallyExpired}
            onClick={openConfirmation}
            data-testid="wizard-open-confirmation"
          >
            Review public publication
          </Button>
          {locallyExpired && (
            <Button type="button" variant="secondary" onClick={() => void startPreview()}>
              Create new preview
            </Button>
          )}
        </div>
      )}

      {machine.kind === 'submitting' && (
        <p className="flex items-center gap-2 text-sm text-text-muted" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
          Creating or recovering the confirmed public pull request…
        </p>
      )}

      {machine.kind === 'retryable_error' && (
        <ErrorView
          error={machine.error}
          action={
            <Button
              type="button"
              onClick={() => void submit(machine.preview)}
              data-testid="wizard-retry-submit"
            >
              Retry this exact publication
            </Button>
          }
        />
      )}

      {machine.kind === 'succeeded' && <ReceiptView receipt={machine.receipt} />}

      <ConfirmDialog
        open={machine.kind === 'confirming'}
        onOpenChange={(open) => {
          if (!open && machine.kind === 'confirming') {
            setMachine({ kind: 'preview_ready', preview: machine.preview });
          }
        }}
        title="Create this public pull request?"
        description={
          activePreview
            ? `Upstream ${activePreview.target.upstream}; push repository ${activePreview.target.pushRepository}; ${activePreview.contribution.recordCount} record(s). ${
                activePreview.target.willCreateFork
                  ? `A public fork ${activePreview.target.pushRepository} may be created first.`
                  : 'No new fork will be created.'
              }`
            : undefined
        }
        confirmLabel="Confirm and create PR"
        cancelLabel="Cancel"
        variant="default"
        testid="publication-confirm"
        returnFocusRef={confirmationTriggerRef}
        onConfirm={() => {
          if (activePreview) void submit(activePreview);
        }}
      />
    </div>
  );
}

function PreviewSummary({
  preview,
  locallyExpired,
}: {
  preview: PublicationPreview;
  locallyExpired: boolean;
}): JSX.Element {
  return (
    <section
      className="min-w-0 space-y-4"
      aria-label="Publication preview"
      data-testid="publication-preview"
    >
      <div className="rounded-md border border-border bg-surface-1 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold">Public target and route</h3>
          <span className={locallyExpired ? 'text-destructive' : 'text-text-muted'}>
            {locallyExpired ? 'Expired' : `Expires ${formatTime(preview.expiresAt)}`}
          </span>
        </div>
        <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
          <Fact label="Upstream PR target" value={preview.target.upstream} />
          <Fact label="Push repository" value={preview.target.pushRepository} />
          <Fact label="Route" value={preview.target.route} />
          <Fact label="Fork provision" value={preview.target.forkProvision} />
          <Fact
            label="Public fork effect"
            value={
              preview.target.willCreateFork
                ? 'A public fork may be created on confirmed submit.'
                : 'No new fork will be created.'
            }
          />
          <Fact label="Base branch" value={preview.target.baseBranch} />
          <Fact label="Base commit" value={preview.target.baseCommitSha} mono />
          <Fact label="Target revision" value={String(preview.target.revision)} />
        </dl>
      </div>

      <div className="rounded-md border border-border bg-surface-1 p-3">
        <h3 className="font-display text-base font-semibold">Pull request</h3>
        <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
          <Fact label="Contribution branch" value={preview.contribution.branch} mono />
          <Fact label="Records" value={String(preview.contribution.recordCount)} />
          <Fact label="Total bytes" value={String(preview.contribution.totalBytes)} />
          <Fact label="Content digest" value={preview.contribution.contentDigest} mono />
          <Fact label="Commit message" value={preview.contribution.commitMessage} />
          <Fact label="PR title" value={preview.contribution.prTitle} />
        </dl>
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">PR body</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 text-sm text-text-muted">
            {preview.contribution.prBody}
          </p>
        </div>
      </div>

      <div className="min-w-0 rounded-md border border-border bg-surface-1 p-3">
        <h3 className="font-display text-base font-semibold">File commitments</h3>
        <div className="mt-3 max-w-full overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[42rem] text-left text-xs">
            <thead className="bg-surface-2 text-text-subtle">
              <tr>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Repository-relative path</th>
                <th className="px-3 py-2 font-medium">Bytes</th>
                <th className="px-3 py-2 font-medium">SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {preview.contribution.files.map((file) => (
                <tr key={`${file.kind}-${file.path}`} className="border-t border-border">
                  <td className="px-3 py-2">{file.kind}</td>
                  <td className="break-all px-3 py-2 font-mono">{file.path}</td>
                  <td className="px-3 py-2 tabular-nums">{file.bytes}</td>
                  <td className="break-all px-3 py-2 font-mono">{file.contentHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AdvancedFold label="Advanced · engine pins">
        <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
          <Fact
            label="Sanitizer"
            value={preview.contribution.engine.sanitizerPackageVersion}
            mono
          />
          <Fact label="Ruleset" value={preview.contribution.engine.rulesetVersion} mono />
          <Fact label="Gitleaks" value={preview.contribution.engine.gitleaksVersion} mono />
          <Fact label="Bundle contract" value={String(preview.contribution.contractVersion)} />
        </dl>
      </AdvancedFold>
    </section>
  );
}

function RefusalView({
  error,
  onJump,
  onRetry,
}: {
  error: PublicationErrorBody;
  onJump: (reviewId: string, ruleId?: string) => void;
  onRetry: () => void;
}): JSX.Element {
  return (
    <section
      className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
      role="alert"
      data-testid="precheck-refused"
    >
      <p className="font-medium text-destructive">{error.message}</p>
      <ul className="space-y-3">
        {(error.refusals ?? []).map((refusal) => (
          <li key={`${refusal.reviewId}-${refusal.sessionId}`} className="rounded-md bg-surface-1 p-3">
            <p className="break-all font-mono text-xs">
              Review {refusal.reviewId} · session {refusal.sessionId}
            </p>
            <ul className="mt-2 space-y-1">
              {Object.entries(refusal.blockingByRule).map(([ruleId, count]) => (
                <li key={ruleId} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Rule <code className="font-mono">{ruleId}</code> · {count} blocking
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="subtle"
                    onClick={() => onJump(refusal.reviewId, ruleId)}
                    data-testid={`jump-to-review-rule-${refusal.reviewId}-${ruleId}`}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Return to review
                  </Button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
        Run preview again
      </Button>
    </section>
  );
}

function ErrorView({
  error,
  onJump,
  action,
}: {
  error: PublicationErrorBody;
  onJump?: (reviewId: string, ruleId?: string) => void;
  action: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
      role="alert"
      data-testid="wizard-error"
    >
      <p className="font-medium text-destructive">{error.message}</p>
      {error.recovery && <p className="break-words text-text-muted">{error.recovery}</p>}
      {error.reviewId && onJump && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onJump(error.reviewId!)}
          data-testid={`jump-to-review-${error.reviewId}`}
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
          Return to affected review
        </Button>
      )}
      {action}
    </section>
  );
}

function ReceiptView({ receipt }: { receipt: PublicationReceipt }): JSX.Element {
  const prUrl = safeGitHubPullRequestUrl(receipt.prUrl, receipt.prNumber);
  return (
    <section
      className="min-w-0 space-y-3 rounded-md border border-success/50 bg-success/10 p-4"
      aria-live="polite"
      data-testid="publication-receipt"
    >
      <div className="flex flex-wrap items-center gap-2 text-success">
        <Check className="h-5 w-5" strokeWidth={1.5} />
        <h3 className="font-display text-base font-semibold">Public pull request ready</h3>
      </div>
      {prUrl ? (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 break-all font-medium text-primary hover:underline"
          data-testid="publication-pr-link"
        >
          Pull request #{receipt.prNumber}
          <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.5} />
        </a>
      ) : (
        <p className="font-medium text-text" data-testid="publication-pr-link-unavailable">
          Pull request #{receipt.prNumber} · link unavailable
        </p>
      )}
      <dl className="grid min-w-0 gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Upstream" value={receipt.upstream} />
        <Fact label="Push repository" value={receipt.pushRepository} />
        <Fact label="Mode" value={receipt.mode} />
        <Fact label="Base branch" value={receipt.baseBranch} mono />
        <Fact label="Base commit" value={receipt.baseCommitSha} mono />
        <Fact label="Contribution branch" value={receipt.branch} mono />
        <Fact label="Contribution commit" value={receipt.commitSha} mono />
        <Fact label="Target revision" value={String(receipt.targetRevision)} />
        <Fact label="Record count" value={String(receipt.recordCount)} />
        <Fact label="Content digest" value={receipt.contentDigest} mono />
        <Fact label="Submitted" value={formatTime(receipt.submittedAt)} />
      </dl>
    </section>
  );
}

function safeGitHubPullRequestUrl(raw: string, prNumber: number): string | null {
  try {
    const url = new URL(raw);
    const match = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(url.pathname);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !match ||
      Number(match[1]) !== prNumber
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isPreviewableStatus(status: PublicationStatus | null): boolean {
  return status?.state === 'ready' || status?.state === 'fork_confirmation_required';
}

function receiptMatchesPreview(
  receipt: PublicationReceipt,
  preview: PublicationPreview,
): boolean {
  return (
    receipt.publicationRef === preview.publicationRef &&
    receipt.targetRevision === preview.target.revision &&
    receipt.contentDigest === preview.contribution.contentDigest &&
    receipt.upstream === preview.target.upstream &&
    receipt.pushRepository === preview.target.pushRepository &&
    receipt.mode === preview.target.route &&
    receipt.baseBranch === preview.target.baseBranch &&
    receipt.baseCommitSha === preview.target.baseCommitSha &&
    receipt.branch === preview.contribution.branch &&
    receipt.recordCount === preview.contribution.recordCount
  );
}

function receiptBindingError(): PublicationErrorBody {
  return {
    code: 'transport_error',
    phase: 'pull_request',
    message: 'The publication service returned an invalid receipt.',
    retryable: true,
    recovery: 'Retry this exact publication. If the problem continues, restart the daemon.',
  };
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className={`mt-0.5 break-all text-text ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function WizardSteps({ machine }: { machine: Machine }): JSX.Element {
  const active =
    machine.kind === 'previewing' || machine.kind === 'refused' || machine.kind === 'error'
      ? 0
      : machine.kind === 'preview_ready' ||
          machine.kind === 'confirming' ||
          machine.kind === 're_preview'
        ? 1
        : 2;
  return (
    <ol className="flex flex-wrap gap-3 text-xs" aria-label="Publication progress">
      {['1. Safety preview', '2. PR preview', '3. Confirm and create PR'].map(
        (label, index) => (
          <li
            key={label}
            aria-current={index === active ? 'step' : undefined}
            className={
              index === active
                ? 'font-medium text-foreground'
                : index < active
                  ? 'text-success'
                  : 'text-text-subtle'
            }
          >
            {label}
          </li>
        ),
      )}
    </ol>
  );
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}
