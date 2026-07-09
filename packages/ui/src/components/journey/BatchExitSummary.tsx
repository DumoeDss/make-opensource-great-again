/**
 * BatchExitSummary — the transitional N>1 step ④ (design B2). The batch exit
 * backend (publisher multi-record plan) and its wizard land in later slices; here
 * the exit page is a signed-sessions summary with a per-item 「下载 .jsonl」 and two
 * disabled placeholder cards for 批量出口①/② — the same placeholder pattern v03
 * slice 2 used for 出口①.
 *
 * Export reuses the existing per-review `exportReview` + a client-side Blob anchor
 * download (no new endpoint). All items reaching this step are signed ⇒ the gate is
 * unlocked, so the 409 branch cannot normally fire — but it still renders inline per
 * item, because the server gate stays the backstop.
 */
import { Download, Send, UploadCloud } from 'lucide-react';
import { useState } from 'react';

import type { ApiClient } from '../../api/client';
import type { QueueItem } from '../../api/types';
import { Button } from '../ui/button';

interface BatchExitSummaryProps {
  client: ApiClient;
  /** The signed queue (every item's signature is complete at step ④). */
  items: QueueItem[];
}

export function BatchExitSummary({ client, items }: BatchExitSummaryProps): JSX.Element {
  // Per-review download error + in-flight, keyed by reviewId.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (item: QueueItem): Promise<void> => {
    const { reviewId } = item.review;
    const sessionId = item.review.report.sessionId;
    setBusy(reviewId);
    setErrors((e) => {
      const { [reviewId]: _removed, ...rest } = e;
      return rest;
    });
    try {
      const result = await client.exportReview(reviewId);
      if (!result.ok) {
        setErrors((e) => ({ ...e, [reviewId]: '导出被拒绝：出口已重新锁定。' }));
        return;
      }
      const jsonl = `${JSON.stringify(result.data.session)}\n`;
      const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${sessionId}.sanitized.jsonl`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErrors((err) => ({ ...err, [reviewId]: String(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="batch-exit-summary">
      <section className="rounded-lg border border-border bg-surface-1 p-5">
        <h3 className="font-display text-lg font-semibold">已签署会话（{items.length}）</h3>
        <p className="mt-1 text-sm text-text-muted">
          全部会话已完成处置与签署。批量出口将在后续切片可用；当前可逐条导出脱敏文件。
        </p>
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {items.map((item) => {
            const sessionId = item.review.report.sessionId;
            const title = item.ref.title ?? sessionId;
            const error = errors[item.review.reviewId];
            return (
              <li key={item.review.reviewId} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" title={title}>
                      {title}
                    </p>
                    <p className="truncate font-mono text-xs text-text-subtle">{sessionId}</p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy === item.review.reviewId}
                    onClick={() => void download(item)}
                    data-testid={`download-item-${sessionId}`}
                  >
                    <Download className="h-4 w-4" strokeWidth={1.5} />
                    下载 .jsonl
                  </Button>
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Placeholder batch-exit cards — enabled in slice 3. */}
      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="flex flex-col rounded-lg border border-dashed border-border bg-surface-1 p-5 opacity-70"
          data-testid="exit-placeholder-one"
        >
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-text-subtle" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">批量出口①　公开数据集</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            将 {items.length} 条脱敏会话合并为一个分支 / 一个 PR 贡献到公开数据仓库。
          </p>
          <p className="mt-2 text-xs text-text-subtle">批量出口将在后续切片可用。</p>
        </section>

        <section
          className="flex flex-col rounded-lg border border-dashed border-border bg-surface-1 p-5 opacity-70"
          data-testid="exit-placeholder-two"
        >
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-text-subtle" strokeWidth={1.5} />
            <h3 className="font-display text-lg font-semibold">批量出口②　API 直投</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            将 {items.length} 条会话逐条直投到你选择的模型服务商，含总成本估算。
          </p>
          <p className="mt-2 text-xs text-text-subtle">批量出口将在后续切片可用。</p>
        </section>
      </div>
    </div>
  );
}
