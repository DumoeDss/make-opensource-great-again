/**
 * Stepper — the persistent 3-step journey rail:
 * ①选择会话 → ②处置命中 → ③选择出口, with a right-aligned lock badge.
 *
 * Signing is no longer a step: donation confirmation is a single dialog raised
 * before the first exit action (see `AffirmDialog`), so the journey is
 * 处置 → 选择出口 → 确认. The badge has three states:
 *   !cleared   → 还差 N 项解锁   (Lock)      — N = pending across the WHOLE queue
 *   cleared    → 已解锁          (Unlock)
 *   completed  → 已完成          (CheckCircle2, success)
 *
 * Step ③ is gated until every session's gate is cleared. Steps ②③ render as
 * `<button>` (`goto-step-N`) navigation, disabled past `maxEnterable`; step ①
 * 「选择会话」 stays non-interactive display (returning to the picker is the header's
 * 「换会话」 link) so there is exactly one entry point.
 */
import { Check, CheckCircle2, Lock, Unlock } from 'lucide-react';

import { cn } from '../../lib/cn';

/** The 1-based journey step the user is currently on. */
export type JourneyStep = 1 | 2 | 3;

interface StepperProps {
  current: JourneyStep;
  /** Every session's gate is unlocked. */
  cleared: boolean;
  completed: boolean;
  /** Pending blocking + non-text count across the WHOLE queue (only meaningful while !cleared). */
  pending: number;
  /** The furthest enterable step; ②③ buttons past this are disabled. */
  maxEnterable: JourneyStep;
  /** Navigate to an enterable step (②③ only; ① is non-interactive display). */
  onNavigate: (n: JourneyStep) => void;
}

const STEPS: Array<{ n: JourneyStep; label: string }> = [
  { n: 1, label: '选择会话' },
  { n: 2, label: '处置命中' },
  { n: 3, label: '选择出口' },
];

function LockBadge({
  cleared,
  completed,
  pending,
}: Pick<StepperProps, 'cleared' | 'completed' | 'pending'>): JSX.Element {
  let label: string;
  let Icon = Lock;
  let tone = 'border-destructive/50 bg-destructive/10 text-destructive';

  if (completed) {
    label = '已完成';
    Icon = CheckCircle2;
    tone = 'border-success/60 bg-success/15 text-success';
  } else if (cleared) {
    label = '已解锁';
    Icon = Unlock;
    tone = 'border-success/50 bg-success/15 text-success';
  } else {
    label = `还差 ${pending} 项解锁`;
    Icon = Lock;
    tone = 'border-destructive/50 bg-destructive/10 text-destructive';
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium',
        tone,
      )}
      data-testid="lock-badge"
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      {label}
    </span>
  );
}

export function Stepper({
  current,
  cleared,
  completed,
  pending,
  maxEnterable,
  onNavigate,
}: StepperProps): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3"
      data-testid="stepper"
    >
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((step, i) => {
          const done = completed ? true : step.n < current;
          const isCurrent = !completed && step.n === current;
          // ③ 选择出口 is gated until every session's gate is cleared.
          const gated = step.n === 3 && !cleared;
          const content = (
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors',
                isCurrent && 'bg-surface-2/60 font-medium text-foreground',
                !isCurrent && done && 'text-foreground',
                !isCurrent && !done && gated && 'text-text-subtle/60',
                !isCurrent && !done && !gated && 'text-text-muted',
              )}
              data-testid={`step-${step.n}`}
              data-current={isCurrent || undefined}
              data-gated={gated || undefined}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]',
                  done
                    ? 'border-success bg-success text-white'
                    : isCurrent
                      ? 'border-primary text-primary'
                      : 'border-border text-text-subtle',
                )}
              >
                {done ? <Check className="h-3 w-3" strokeWidth={2} /> : step.n}
              </span>
              <span className="whitespace-nowrap">{step.label}</span>
            </span>
          );
          return (
            <li key={step.n} className="flex items-center gap-2">
              {step.n === 1 ? (
                content
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(step.n)}
                  disabled={step.n > maxEnterable}
                  data-testid={`goto-step-${step.n}`}
                  className="rounded-md enabled:cursor-pointer enabled:hover:bg-surface-2/50 disabled:cursor-not-allowed"
                >
                  {content}
                </button>
              )}
              {i < STEPS.length - 1 && (
                <span className="h-px w-4 bg-border" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
      <LockBadge cleared={cleared} completed={completed} pending={pending} />
    </div>
  );
}
