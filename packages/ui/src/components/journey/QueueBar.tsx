/**
 * QueueBar — the multi-session queue strip above the stepper. Shown only for N>1.
 * Two fixed rows so nothing shifts as titles vary:
 *   row 1 — 「会话 k/N · <title>」 (title truncates, owns its own line)
 *   row 2 — a triage chip per session (left) + the queue-level 一键清洗 (right)
 *
 * Signing is no longer per-session, so chips carry no 已签署 state. Three states let
 * you tell at a glance WHICH session still needs work without opening it:
 * 当前 (the open session) / 待处置 (pending>0, red, with a hit-count badge) /
 * 无需处置 (pending===0, green).
 */
import { Unlock, Wand2 } from 'lucide-react';

import type { QueueItem } from '../../api/types';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

interface QueueBarProps {
  items: QueueItem[];
  current: number;
  /** Per-item pending count (blockingPending + nonTextPending), index-aligned. */
  pending: number[];
  onSelect: (index: number) => void;
  /** Total auto-cleanable hits across the queue; the button shows when > 0. */
  queueCleanableCount?: number;
  /** Replace-all across every session's cleanable hits. */
  onCleanQueue?: () => void;
  busy?: boolean;
}

export function QueueBar({
  items,
  current,
  pending,
  onSelect,
  queueCleanableCount = 0,
  onCleanQueue,
  busy,
}: QueueBarProps): JSX.Element {
  const currentTitle = items[current].ref.title ?? items[current].review.report.sessionId;

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 px-4 py-2.5"
      data-testid="queue-bar"
    >
      {/* Row 1: the current session's position + title (title owns this line). */}
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <span className="shrink-0">
          会话 {current + 1}/{items.length}
        </span>
        <span className="min-w-0 truncate text-text-muted" title={currentTitle}>
          · {currentTitle}
        </span>
      </div>

      {/* Row 2: the triage chips (fixed position) + the queue-level clean button. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => {
            const isCurrent = i === current;
            const hits = pending[i] ?? 0;
            const state = isCurrent ? '当前' : hits > 0 ? '待处置' : '无需处置';
            const tone = isCurrent
              ? 'border-primary bg-primary-soft/30 text-primary'
              : hits > 0
                ? 'border-destructive/50 bg-destructive/10 text-destructive'
                : 'border-success/40 bg-success/5 text-success';
            return (
              <button
                key={item.review.reviewId}
                type="button"
                onClick={() => onSelect(i)}
                data-testid={`queue-item-${i + 1}`}
                data-state={state}
                data-current={isCurrent || undefined}
                title={`${item.ref.title ?? item.review.report.sessionId} — ${
                  hits > 0 ? `还差 ${hits} 项` : '无需人工处置'
                }`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                  tone,
                  isCurrent && 'ring-1 ring-primary ring-offset-1 ring-offset-surface-1',
                )}
              >
                {!isCurrent && hits === 0 && <Unlock className="h-3.5 w-3.5" strokeWidth={1.5} />}
                {i + 1}
                {hits > 0 && (
                  <span className="rounded-full bg-destructive/20 px-1 text-[10px] font-medium">·{hits}</span>
                )}
              </button>
            );
          })}
        </div>

        {onCleanQueue && queueCleanableCount > 0 && (
          <Button
            type="button"
            size="xs"
            variant="subtle"
            disabled={busy}
            onClick={onCleanQueue}
            data-testid="queue-clean-all"
            className="shrink-0"
          >
            <Wand2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            一键替换全部会话命中（{queueCleanableCount} 处）
          </Button>
        )}
      </div>
    </div>
  );
}
