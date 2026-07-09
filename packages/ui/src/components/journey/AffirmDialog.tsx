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

/** The confirmation summary the reviewer affirms to unlock the exits. */
export const SIGNED_SUMMARY = '命中项已全部处置 + 含图记录已逐条确认 + 抽检通过';

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
          <DialogTitle className="font-display text-xl">数据捐赠确认</DialogTitle>
          <DialogDescription>
            你即将确认对以下 {reports.length} 个会话的全部处置。请核对聚合摘要后确认。
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 rounded-md border border-border bg-surface-0 p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">会话数</dt>
            <dd className="font-mono" data-testid="summary-sessions">
              {reports.length}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">命中处置</dt>
            <dd className="font-mono" data-testid="summary-dispositions">
              替换 {summary.replace} · 删除 {summary.delete} · 放行 {summary.allow}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">含图记录</dt>
            <dd className="font-mono" data-testid="summary-nontext">
              保留 {summary.nonTextKeep} · 排除 {summary.nonTextRemove} / 共 {summary.nonTextTotal}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">归一化统计</dt>
            <dd className="font-mono" data-testid="summary-l3">
              {summary.l3Total} 处 · {summary.l3Categories} 类（抽检通过，不阻断）
            </dd>
          </div>
        </dl>

        <p className="text-sm">
          我确认：<b>{SIGNED_SUMMARY}</b>
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="affirm-cancel"
            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-surface-1"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            data-testid="affirm-confirm"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <PenLine className="h-4 w-4" strokeWidth={1.5} />
            确认并继续
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
