/**
 * AdvancedFold — a token-styled native `<details>` used to demote raw JSON out of
 * the primary view (design premise 3). Human-readable summaries stay primary;
 * the raw payload lives behind a collapsed 「高级」 fold.
 */
import { ChevronRight } from 'lucide-react';

import { cn } from '../../lib/cn';

interface AdvancedFoldProps {
  /** Summary label; defaults to 「高级」. */
  label?: string;
  className?: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

export function AdvancedFold({
  label = '高级',
  className,
  children,
  ...rest
}: AdvancedFoldProps): JSX.Element {
  return (
    <details className={cn('group rounded-md border border-border', className)} {...rest}>
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-sm text-text-muted marker:content-['']">
        <ChevronRight
          className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
          strokeWidth={1.5}
        />
        {label}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}
