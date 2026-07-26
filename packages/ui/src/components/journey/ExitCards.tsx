/**
 * ExitCards — step ④ (design B3/B4). Two equal exit cards + a low-key secondary
 * export. 出口①「公开数据集」is now a preflight-driven four-state card (就绪 /
 * 需配置 / gh 未登录 / 缺依赖); 就绪 (and gh 未登录, via the manual path) opens the
 * three-step `PublishWizard`. 出口②「API 直投」reuses `SubmitPanel` with every
 * semantic intact; its receipt is the journey's completion state. 「仅导出脱敏
 * 文件」 keeps the existing sanitized-export path.
 */
import { Download, Send, UploadCloud } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../../api/client';
import type { SanitizationReport, SanitizedSession, SubmissionReceipt } from '../../api/types';
import { usePreflight } from '../../lib/usePreflight';
import { ExportPreview } from '../ExportPreview';
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
  onSubmitted: (receipt: SubmissionReceipt) => void;
  /** A successful 出口① publish → the journey's 已完成 state. */
  onPublished: () => void;
  /** From the wizard's `precheck_refused` view: jump back to step ② for a rule. */
  onJumpToRule: (ruleId: string) => void;
  /**
   * Gate the first exit action behind the one-time donation confirm (design B3).
   * Optional so `ExitCards` stays independently usable — defaults to running the
   * action directly.
   */
  requireAffirm?: (proceed: () => void) => void;
}

/** Guidance i18n key for each non-ready preflight state. */
const STATE_GUIDANCE_KEY: Record<string, string> = {
  需配置: 'exit.guidanceNeedsConfig',
  缺依赖: 'exit.guidanceMissingDeps',
  gh未登录: 'exit.guidanceGhUnauth',
};

export function ExitCards({
  client,
  reviewId,
  gate,
  exported,
  exporting,
  onExport,
  onSubmitted,
  onPublished,
  onJumpToRule,
  requireAffirm,
}: ExitCardsProps): JSX.Element {
  const { t } = useTranslation();
  const [showExport, setShowExport] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const { state, flags } = usePreflight(client);

  // Route an exit action through the donation confirm if provided, else run it.
  const guard = requireAffirm ?? ((proceed: () => void) => proceed());

  const ghReady = !!(flags?.ghAvailable && flags?.ghAuthenticated);
  const canPublish = state === '就绪' || state === 'gh未登录';
  const ctaLabel =
    state === 'loading'
      ? t('exit.ctaProbing')
      : state === 'gh未登录'
        ? t('exit.ctaManualPublish')
        : t('exit.ctaPublish');

  return (
    <div className="space-y-4" data-testid="exit-cards">
      <div className="grid gap-4 md:grid-cols-2">
        {/* 出口① — preflight-driven four-state card + inline publish wizard. */}
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

          <div className="mt-2 text-xs" data-testid="exit-one-state">
            <span
              className={
                state === '就绪'
                  ? 'text-success'
                  : state === 'loading'
                    ? 'text-text-subtle'
                    : 'text-warning'
              }
            >
              {t('exit.stateLabel', { state: state === 'loading' ? t('exit.stateProbing') : state })}
            </span>
          </div>
          {state !== 'loading' && state !== '就绪' && STATE_GUIDANCE_KEY[state] && (
            <p className="mt-1 flex-1 text-xs text-text-subtle" data-testid="exit-one-guidance">
              {t(STATE_GUIDANCE_KEY[state])}
            </p>
          )}

          {wizardOpen ? (
            <div className="mt-4">
              <PublishWizard
                client={client}
                reviewId={reviewId}
                ghReady={ghReady}
                onPublished={onPublished}
                onJumpToRule={(ruleId) => {
                  setWizardOpen(false);
                  onJumpToRule(ruleId);
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
            <SubmitPanel
              client={client}
              reviewId={reviewId}
              gate={gate}
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
