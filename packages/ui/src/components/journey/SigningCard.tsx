/**
 * SigningCard — step ③ (design B3). Greyed/unenterable until the gate clears;
 * once cleared it surfaces a ceremony card with a Georgia (`font-display`) title
 * 「数据捐赠确认」, a disposition summary (replace/delete/allow counts, non-text
 * confirm counts, Layer-3 stats + spot-check line), the affirmation checkbox with
 * the signed-summary text, and a 「签署并继续」 button that unlocks step ④.
 *
 * Signing is client-side state owned by the journey container; this card only
 * affirms + emits `onSign`. Changing a disposition after signing voids it — that
 * guard lives in the container.
 */
import { PenLine } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { Finding, SanitizationReport } from '../../api/types';
import { blockingFindings } from '../../lib/findings';
import { Button } from '../ui/button';

/** The signed confirmation summary the reviewer must affirm to unlock the exit. */
export const SIGNED_SUMMARY = '命中项已全部处置 + 含图记录已逐条确认 + 抽检通过';

interface SigningCardProps {
  report: SanitizationReport;
  onSign: () => void;
}

function countBy(findings: Finding[], d: Finding['disposition']): number {
  return findings.filter((f) => f.disposition === d).length;
}

export function SigningCard({ report, onSign }: SigningCardProps): JSX.Element {
  const [affirmed, setAffirmed] = useState(false);
  const locked = !report.gate.unlocked;

  const summary = useMemo(() => {
    const blocking = blockingFindings(report);
    const nonText = report.nonTextItems;
    return {
      replace: countBy(blocking, 'replace'),
      delete: countBy(blocking, 'delete'),
      allow: countBy(blocking, 'allow'),
      nonTextKeep: nonText.filter((n) => n.disposition === 'keep').length,
      nonTextRemove: nonText.filter((n) => n.disposition === 'remove').length,
      nonTextTotal: nonText.length,
      l3Total: report.layerSummary.normalization.total,
      l3Categories: Object.keys(report.layerSummary.normalization.byCategory).length,
    };
  }, [report]);

  return (
    <div
      className="mx-auto max-w-xl rounded-lg border border-border bg-surface-1 p-6"
      data-testid="signing-card"
    >
      <h2 className="font-display text-xl font-semibold tracking-tight">数据捐赠确认</h2>
      <p className="mt-1 text-sm text-text-muted">
        你即将确认对本次会话的全部处置。请核对以下摘要后签署。
      </p>

      <dl className="mt-4 space-y-2 rounded-md border border-border bg-surface-0 p-4 text-sm">
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

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={affirmed}
          disabled={locked}
          onChange={(e) => setAffirmed(e.target.checked)}
          data-testid="sign-checkbox"
          className="mt-0.5 accent-primary"
        />
        <span>
          我确认：<b>{SIGNED_SUMMARY}</b>
          {locked && (
            <span className="ml-1 text-destructive">
              （处置所有阻断项与含图记录后方可签署）
            </span>
          )}
        </span>
      </label>

      <Button
        type="button"
        onClick={onSign}
        disabled={locked || !affirmed}
        size="lg"
        className="mt-4 w-full"
        data-testid="sign-submit"
      >
        <PenLine className="h-4 w-4" strokeWidth={1.5} />
        签署并继续
      </Button>
    </div>
  );
}
