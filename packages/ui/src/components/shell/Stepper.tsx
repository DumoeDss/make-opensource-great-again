/**
 * Stepper — the persistent 4-step journey rail (design B2/B3):
 * ①选择会话 → ②处置命中 → ③签署确认 → ④选择出口, with a right-aligned lock badge.
 *
 * The badge has four states derived by the journey container:
 *   !cleared           → 还差 N 项解锁   (Lock)
 *   cleared && !signed → 已解锁          (Unlock)
 *   signed && !done    → 已签署          (CheckCircle2)
 *   completed          → 已完成          (CheckCircle2, success)
 *
 * Steps ③ and ④ are gated: ③ is dimmed until `cleared`, ④ until `signed`.
 *
 * Steps ②③④ are the journey's navigation: each renders as a `<button>`
 * (`goto-step-N`) that calls `onNavigate`, disabled past `maxEnterable`. Step ①
 * 「选择会话」 stays non-interactive display (returning to the picker is the header's
 * 「换会话」 link) so there is exactly one entry point, not two.
 */
import { Check, CheckCircle2, Lock, Unlock } from 'lucide-react';

import { cn } from '../../lib/cn';

/** The 1-based journey step the user is currently on. */
export type JourneyStep = 1 | 2 | 3 | 4;

interface StepperProps {
  current: JourneyStep;
  cleared: boolean;
  signed: boolean;
  completed: boolean;
  /** Pending blocking + non-text count (only meaningful while !cleared). */
  pending: number;
  /** The furthest enterable step; ②③④ buttons past this are disabled. */
  maxEnterable: JourneyStep;
  /** Navigate to an enterable step (②③④ only; ① is non-interactive display). */
  onNavigate: (n: JourneyStep) => void;
}

const STEPS: Array<{ n: JourneyStep; label: string }> = [
  { n: 1, label: '选择会话' },
  { n: 2, label: '处置命中' },
  { n: 3, label: '签署确认' },
  { n: 4, label: '选择出口' },
];

function LockBadge({
  cleared,
  signed,
  completed,
  pending,
}: Pick<StepperProps, 'cleared' | 'signed' | 'completed' | 'pending'>): JSX.Element {
  let label: string;
  let Icon = Lock;
  let tone = 'border-destructive/50 bg-destructive/10 text-destructive';

  if (completed) {
    label = '已完成';
    Icon = CheckCircle2;
    tone = 'border-success/60 bg-success/15 text-success';
  } else if (signed) {
    label = '已签署';
    Icon = CheckCircle2;
    tone = 'border-primary/50 bg-primary-soft/30 text-primary';
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
  signed,
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
          // ③ gated until cleared; ④ gated until signed.
          const gated = (step.n === 3 && !cleared) || (step.n === 4 && !signed);
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
      <LockBadge cleared={cleared} signed={signed} completed={completed} pending={pending} />
    </div>
  );
}
