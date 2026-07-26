/**
 * AffirmDialog — the single donation-confirmation dialog (replaces the per-session
 * signing step). Raised ONCE before the first exit action; its summary aggregates
 * EVERY session in the queue (not one at a time — the user's complaint), so the
 * shortest donation path is 一键替换 → 选择出口 → 确认.
 *
 * Confirming is client-side affirmation only; the server's per-review gate 409
 * stays the final backstop, and each 出口② consent is still content-bound. Editing
 * any disposition after confirming voids the affirmation (guarded in the container).
 */
import { PenLine } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Finding, SanitizationReport } from '../../api/types';
import { blockingFindings } from '../../lib/findings';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/** The confirmation summary i18n key the reviewer affirms to unlock the exits. */
export const SIGNED_SUMMARY = 'affirm.confirmStatement';

interface AffirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every session's report — the summary aggregates across all of them. */
  reports: SanitizationReport[];
  onConfirm: () => void;
}

function countBy(findings: Finding[], d: Finding['disposition']): number {
  return findings.filter((f) => f.disposition === d).length;
}

/** Aggregate the disposition summary across every session in the queue. */
function aggregate(reports: SanitizationReport[]) {
  let replace = 0;
  let del = 0;
  let allow = 0;
  let nonTextKeep = 0;
  let nonTextRemove = 0;
  let nonTextTotal = 0;
  let l3Total = 0;
  const categories = new Set<string>();
  for (const report of reports) {
    const blocking = blockingFindings(report);
    replace += countBy(blocking, 'replace');
    del += countBy(blocking, 'delete');
    allow += countBy(blocking, 'allow');
    nonTextKeep += report.nonTextItems.filter((n) => n.disposition === 'keep').length;
    nonTextRemove += report.nonTextItems.filter((n) => n.disposition === 'remove').length;
    nonTextTotal += report.nonTextItems.length;
    l3Total += report.layerSummary.normalization.total;
    for (const k of Object.keys(report.layerSummary.normalization.byCategory)) categories.add(k);
  }
  return { replace, delete: del, allow, nonTextKeep, nonTextRemove, nonTextTotal, l3Total, l3Categories: categories.size };
}

export function AffirmDialog({ open, onOpenChange, reports, onConfirm }: AffirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  const summary = useMemo(() => aggregate(reports), [reports]);

  // Run the pending exit action BEFORE closing, so the container's close handler
  // (which discards a pending action on cancel) cannot drop it on confirm.
  const handleConfirm = (): void => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" hideCloseButton data-testid="affirm-dialog">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">{t('affirm.title')}</DialogTitle>
          <DialogDescription>
            {t('affirm.description', { count: reports.length })}
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 rounded-md border border-border bg-surface-0 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">{t('affirm.sessions')}</dt>
            <dd className="font-mono" data-testid="summary-sessions">
              {reports.length}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">{t('affirm.dispositions')}</dt>
            <dd className="font-mono" data-testid="summary-dispositions">
              {t('affirm.dispositionSummary', { r: summary.replace, d: summary.delete, a: summary.allow })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">{t('affirm.nonText')}</dt>
            <dd className="font-mono" data-testid="summary-nontext">
              {t('affirm.nonTextSummary', { keep: summary.nonTextKeep, remove: summary.nonTextRemove, total: summary.nonTextTotal })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">{t('affirm.normalization')}</dt>
            <dd className="font-mono" data-testid="summary-l3">
              {t('affirm.normalizationSummary', { total: summary.l3Total, categories: summary.l3Categories })}
            </dd>
          </div>
        </dl>

        <p className="text-sm">
          {t('affirm.iConfirm')}<b>{t(SIGNED_SUMMARY)}</b>
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="affirm-cancel"
            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-1"
          >
            {t('affirm.cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            data-testid="affirm-confirm"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PenLine className="h-4 w-4" strokeWidth={1.5} />
            {t('affirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
