/**
 * BatchExitCards — the N>1 step ④ (design B4), replacing the transitional
 * `BatchExitSummary`. Layout mirrors the single `ExitCards` (two exit cards + a
 * low-key export under a divider), but every exit is batch-wide:
 *
 *   出口① — the same daemon-owned target status and `PublishWizard` as a
 *           one-review journey (N records → one branch/one PR).
 *   出口② — the `BatchSubmitPanel` (aggregate estimate + per-item content-bound
 *           consent, sequential submit with per-item receipts/retry).
 *   导出   — 「导出全部脱敏文件」 + per-item downloads: `exportReview` per review, a
 *           `<sessionId>.sanitized.jsonl` blob (`JSON.stringify(session) + '\n'`,
 *           byte-identical to the publisher's `fileContents`); a refused/failed
 *           export renders inline per item and writes no file.
 *
 * EITHER exit completes the journey (`onPublished` / `onSubmittedAll` → 已完成).
 * Single and batch differ only in the `reviewIds` selection and surrounding copy.
 */
import { Download, Send, UploadCloud } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import { usePublication } from '../../lib/usePublication';
import {
  canPreviewPublication,
  PublicationStatusView,
} from '../publication/PublicationStatusView';
import { Button } from '../ui/button';
import { BatchSubmitPanel } from './BatchSubmitPanel';
import { PublishWizard } from './PublishWizard';

/** A signed review reaching the batch exit step. */
export interface BatchExitItem {
  reviewId: string;
  sessionId: string;
  title: string;
}

interface BatchExitCardsProps {
  client: ApiClient;
  /** The signed queue (every item's gate is unlocked at step ④). */
  items: BatchExitItem[];
  /** A successful 批量出口① publish → the journey's 已完成 state. */
  onPublished: () => void;
  /** Every 批量出口② direct-submit succeeded → the journey's 已完成 state. */
  onSubmittedAll: () => void;
  /** From the wizard's `precheck_refused` view: jump back to a session's step ②. */
  onJumpToSession: (reviewId: string, ruleId?: string) => void;
  /**
   * Gate the first batch exit action behind the one-time donation confirm (B3).
   * Optional so the cards stay independently usable — defaults to running directly.
   */
  requireAffirm?: (proceed: () => void) => void;
}

export function BatchExitCards({
  client,
  items,
  onPublished,
  onSubmittedAll,
  onJumpToSession,
  requireAffirm,
}: BatchExitCardsProps): JSX.Element {
  const { t } = useTranslation();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const publication = usePublication(client);

  // Route an exit action through the donation confirm if provided, else run it.
  const guard = requireAffirm ?? ((proceed: () => void) => proceed());

  const canPublish =
    publication.loadState === 'loaded' &&
    canPreviewPublication(publication.status);
  const ctaLabel =
    publication.loadState === 'loading' ? 'Checking target…' : 'Preview public PR';
  const reviewIds = items.map((i) => i.reviewId);

  const download = async (item: BatchExitItem): Promise<void> => {
    setBusy(item.reviewId);
    setErrors((e) => {
      const { [item.reviewId]: _removed, ...rest } = e;
      return rest;
    });
    try {
      const result = await client.exportReview(item.reviewId);
      if (!result.ok) {
        setErrors((e) => ({ ...e, [item.reviewId]: t('batchExit.exportRefused') }));
        return;
      }
      const jsonl = `${JSON.stringify(result.data.session)}\n`;
      const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${item.sessionId}.sanitized.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErrors((err) => ({ ...err, [item.reviewId]: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const downloadAll = async (): Promise<void> => {
    for (const item of items) await download(item); // sequential (one local daemon)
  };

  return (
    <div className="space-y-4" data-testid="batch-exit-cards">
      <div className="grid gap-4 md:grid-cols-2">
        {/* 批量出口① — shared status and publication wizard. */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="batch-exit-one"
        >
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">{t('batchExit.oneTitle')}</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {t('batchExit.oneDescription', { count: items.length })}
          </p>

          <div className="mt-3 flex-1" data-testid="batch-exit-one-state" aria-live="polite">
            {publication.loadState === 'loading' && (
              <p className="text-xs text-text-subtle">Loading GitHub target status…</p>
            )}
            {publication.status && (
              <PublicationStatusView status={publication.status} />
            )}
            {publication.loadState === 'error' && publication.error && (
              <div role="alert" className="space-y-1 text-xs text-destructive">
                <p>{publication.error.message}</p>
                {publication.error.recovery && <p>{publication.error.recovery}</p>}
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => void publication.refresh()}
                >
                  Retry status
                </Button>
              </div>
            )}
          </div>

          {wizardOpen ? (
            <div className="mt-4">
              <PublishWizard
                client={client}
                reviewIds={reviewIds}
                onPublished={onPublished}
                onRefreshStatus={publication.refresh}
                onJumpToReviewIssue={(reviewId, ruleId) => {
                  setWizardOpen(false);
                  onJumpToSession(reviewId, ruleId);
                }}
              />
            </div>
          ) : (
            <Button
              type="button"
              variant={canPublish ? 'default' : 'secondary'}
              className="mt-4 w-full"
              disabled={!canPublish}
              onClick={() => guard(() => setWizardOpen(true))}
              data-testid="batch-exit-one-cta"
            >
              {ctaLabel}
            </Button>
          )}
        </section>

        {/* 批量出口② — direct submit over the per-review endpoints. */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="batch-exit-two"
        >
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">{t('batchExit.twoTitle')}</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {t('batchExit.twoDescription', { count: items.length })}
          </p>
          <div className="mt-4">
            <BatchSubmitPanel
              client={client}
              items={items}
              onSubmittedAll={onSubmittedAll}
              beforeRun={requireAffirm}
            />
          </div>
        </section>
      </div>

      {/* Low-key secondary: export the sanitized files. */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-muted">{t('batchExit.exportLabel', { count: items.length })}</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => guard(() => void downloadAll())}
            disabled={busy !== null}
            data-testid="batch-export-all"
          >
            <Download className="h-4 w-4" strokeWidth={1.5} />
            {t('batchExit.exportAll')}
          </Button>
        </div>
        <ul className="mt-2 divide-y divide-border rounded-md border border-border">
          {items.map((item) => {
            const error = errors[item.reviewId];
            return (
              <li key={item.reviewId} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm" title={item.title}>
                      {item.title}
                    </p>
                    <p className="truncate font-mono text-xs text-text-subtle">{item.sessionId}</p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy === item.reviewId}
                    onClick={() => guard(() => void download(item))}
                    data-testid={`batch-download-${item.sessionId}`}
                  >
                    <Download className="h-4 w-4" strokeWidth={1.5} />
                    {t('batchExit.downloadJsonl')}
                  </Button>
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
