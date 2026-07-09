/**
 * ExitCards — step ④ (design B3). Two equal exit cards + a low-key secondary
 * export. 出口①「公开数据集」is a readiness-state placeholder ONLY (the 3-step
 * publish wizard is slice 3 — no daemon publish call here). 出口②「API 直投」
 * reuses `SubmitPanel` with every semantic intact; its receipt is the journey's
 * completion state. 「仅导出脱敏文件」 keeps the existing sanitized-export path.
 */
import { Download, Send, UploadCloud } from 'lucide-react';
import { useState } from 'react';

import type { ApiClient } from '../../api/client';
import type { SanitizationReport, SanitizedSession, SubmissionReceipt } from '../../api/types';
import { ExportPreview } from '../ExportPreview';
import { SubmitPanel } from '../SubmitPanel';
import { Button } from '../ui/button';

interface ExitCardsProps {
  client: ApiClient;
  reviewId: string;
  gate: SanitizationReport['gate'];
  exported: SanitizedSession | null;
  exporting?: boolean;
  onExport: () => void;
  onSubmitted: (receipt: SubmissionReceipt) => void;
}

export function ExitCards({
  client,
  reviewId,
  gate,
  exported,
  exporting,
  onExport,
  onSubmitted,
}: ExitCardsProps): JSX.Element {
  const [showExport, setShowExport] = useState(false);

  return (
    <div className="space-y-4" data-testid="exit-cards">
      <div className="grid gap-4 md:grid-cols-2">
        {/* 出口① — readiness placeholder (wizard arrives in the publish slice). */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="exit-one"
        >
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">出口①　公开数据集</h3>
          </div>
          <p className="mt-2 flex-1 text-sm text-text-muted">
            将脱敏后的会话作为 PR 贡献到公开数据仓库：预检 → PR 预览 → 提交。为最大化开放价值的
            首选通道。
          </p>
          <Button
            type="button"
            variant="secondary"
            className="mt-4 w-full"
            disabled
            data-testid="exit-one-cta"
          >
            发布向导即将接入
          </Button>
        </section>

        {/* 出口② — direct submit (all SubmitPanel semantics preserved). */}
        <section
          className="flex flex-col rounded-lg border border-border bg-surface-1 p-5"
          data-testid="exit-two"
        >
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">出口②　API 直投</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            将本次会话直投到你选择的模型服务商，用于回放评测。含成本估算与双重知情确认。
          </p>
          <div className="mt-4">
            <SubmitPanel client={client} reviewId={reviewId} gate={gate} onSubmitted={onSubmitted} />
          </div>
        </section>
      </div>

      {/* Low-key secondary: export the sanitized file only. */}
      <div className="border-t border-border pt-3">
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={() => {
            setShowExport(true);
            onExport();
          }}
          disabled={!gate.unlocked || exporting}
          data-testid="export-secondary"
        >
          <Download className="h-4 w-4" strokeWidth={1.5} />
          {exporting ? '导出中…' : '仅导出脱敏文件'}
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
