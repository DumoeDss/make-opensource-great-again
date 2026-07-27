/**
 * ExitCards — step ④ (design B3/B4). Two equal exit cards + a low-key secondary
 * export. 出口① consumes the daemon-owned publication status and opens the shared
 * preview/confirm/submit wizard only when publication can proceed. 出口② reuses
 * `SubmitPanel` with every
 * semantic intact; its receipt is the journey's completion state. 「仅导出脱敏
 * 文件」 keeps the existing sanitized-export path.
 */
import { Download, Send, UploadCloud } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { CliResumeReceipt, SanitizationReport, SanitizedSession, SubmissionReceipt } from '../../api/types';
import { usePublication } from '../../lib/usePublication';
import { ExportPreview } from '../ExportPreview';
import { ReplayPreparation } from '../ReplayPreparation';
import {
  canPreviewPublication,
  PublicationStatusView,
} from '../publication/PublicationStatusView';
import { SubmitPanel } from '../SubmitPanel';
import { Button } from '../ui/button';
import { PublishWizard } from './PublishWizard';

interface ExitCardsProps {
  client: ApiClient;
  reviewId: string;
  gate: SanitizationReport['gate'];
  exported: SanitizedSession | null;
  exporting?: boolean;
  onExport: () => void;
  onSubmitted: (receipt: SubmissionReceipt | CliResumeReceipt) => void;
  /** A successful 出口① publish → the journey's 已完成 state. */
  onPublished: () => void;
  /** Return an attributed publication error to the disposition workspace. */
  onJumpToReviewIssue: (reviewId: string, ruleId?: string) => void;
  /**
   * Gate the first exit action behind the one-time donation confirm (design B3).
   * Optional so `ExitCards` stays independently usable — defaults to running the
   * action directly.
   */
  requireAffirm?: (proceed: () => void) => void;
}

export function ExitCards({
  client,
  reviewId,
  gate,
  exported,
  exporting,
  onExport,
  onSubmitted,
  onPublished,
  onJumpToReviewIssue,
  requireAffirm,
}: ExitCardsProps): JSX.Element {
  const { t } = useTranslation();
  const [showExport, setShowExport] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  // The sealed replay bundle produced by the preparation flow; passed to
  // SubmitPanel so cli-resume submit is enabled end-to-end.
  const [replayBundle, setReplayBundle] = useState<unknown>(null);
  const [bundleContentHash, setBundleContentHash] = useState<string | undefined>(undefined);
  const publication = usePublication(client);

  // Route an exit action through the donation confirm if provided, else run it.
  const guard = requireAffirm ?? ((proceed: () => void) => proceed());

  const canPublish =
    publication.loadState === 'loaded' &&
    canPreviewPublication(publication.status);
  const ctaLabel =
    publication.loadState === 'loading' ? 'Checking target…' : 'Preview public PR';

  return (
    <div className="space-y-4" data-testid="exit-cards">
      <div className="grid gap-4 md:grid-cols-2">
        {/* 出口① — server-owned target status + one shared publication wizard. */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="exit-one"
        >
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">{t('exit.oneTitle')}</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {t('exit.oneDescription')}
          </p>

          <div className="mt-3 flex-1" data-testid="exit-one-state" aria-live="polite">
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
                reviewIds={[reviewId]}
                onPublished={onPublished}
                onRefreshStatus={publication.refresh}
                onJumpToReviewIssue={(attributedReviewId, ruleId) => {
                  setWizardOpen(false);
                  onJumpToReviewIssue(attributedReviewId, ruleId);
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
              data-testid="exit-one-cta"
            >
              {ctaLabel}
            </Button>
          )}
        </section>

        {/* 出口② — direct submit (all SubmitPanel semantics preserved). */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="exit-two"
        >
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">{t('exit.twoTitle')}</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {t('exit.twoDescription')}
          </p>
          <div className="mt-4">
            <ReplayPreparation
              client={client}
              reviewId={reviewId}
              onSealed={(bundle, hash) => {
                setReplayBundle(bundle);
                setBundleContentHash(hash);
              }}
            />
          </div>
          <div className="mt-4">
            <SubmitPanel
              client={client}
              reviewId={reviewId}
              gate={gate}
              replayBundle={replayBundle}
              bundleContentHash={bundleContentHash}
              onSubmitted={onSubmitted}
              beforeSubmit={requireAffirm}
            />
          </div>
        </section>
      </div>

      {/* Low-key secondary: export the sanitized file only. */}
      <div className="border-t border-border pt-3">
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() =>
            guard(() => {
              setShowExport(true);
              onExport();
            })
          }
          disabled={!gate.unlocked || exporting}
          data-testid="export-secondary"
        >
          <Download className="h-4 w-4" strokeWidth={1.5} />
          {exporting ? t('exit.exporting') : t('exit.exportOnly')}
        </Button>
        {showExport && (
          <div className="mt-3">
            <ExportPreview session={exported} />
          </div>
        )}
      </div>
    </div>
  );
}
