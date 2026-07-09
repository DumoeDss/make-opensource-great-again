/**
 * QueueBar — the multi-session queue strip above the stepper (design B2). Shown
 * only for N>1 (a single-session journey keeps the pre-queue DOM, no phantom
 * 会话 1/1). Renders 「会话 k/N · <title>」 plus a clickable chip per item whose
 * state — 待处理 / 当前 / 已签署 — mirrors the container's per-item signed flags.
 *
 * Switching is allowed anytime; the container clamps the active step to the picked
 * item's enterable maximum. Pure presentation — click intent flows out via `onSelect`.
 */
import { CheckCircle2 } from 'lucide-react';

import type { QueueItem } from '../../api/types';
import { cn } from '../../lib/cn';

interface QueueBarProps {
  items: QueueItem[];
  current: number;
  /** Per-item signed flags, index-aligned with `items`. */
  signed: boolean[];
  onSelect: (index: number) => void;
}

export function QueueBar({ items, current, signed, onSelect }: QueueBarProps): JSX.Element {
  const currentTitle = items[current].ref.title ?? items[current].review.report.sessionId;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 px-4 py-2.5"
      data-testid="queue-bar"
    >
      <span className="mr-1 text-sm font-medium">
        会话 {current + 1}/{items.length}
        <span className="ml-2 text-text-muted">· {currentTitle}</span>
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => {
          const isCurrent = i === current;
          const isSigned = signed[i];
          const state = isCurrent ? '当前' : isSigned ? '已签署' : '待处理';
          return (
            <button
              key={item.review.reviewId}
              type="button"
              onClick={() => onSelect(i)}
              data-testid={`queue-item-${i + 1}`}
              data-state={state}
              title={item.ref.title ?? item.review.report.sessionId}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                isCurrent
                  ? 'border-primary bg-primary-soft/30 text-primary'
                  : isSigned
                    ? 'border-success/50 bg-success/10 text-success'
                    : 'border-border text-text-muted hover:bg-surface-2',
              )}
            >
              {isSigned && <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
