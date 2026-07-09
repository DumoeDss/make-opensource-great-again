import { AlertTriangle } from 'lucide-react';

import type { RulesetWarning } from '../api/types';

interface WarningsBannerProps {
  warnings: RulesetWarning[];
}

/**
 * Surfaces the scan's `rulesetWarnings[]` (rules that failed to compile on this
 * runtime). Never hidden — the design doc bans silent truncation at the rule
 * boundary. A `degradedTo:'none'` warning also appears as a blocking finding.
 */
export function WarningsBanner({ warnings }: WarningsBannerProps): JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <div
      className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground"
      data-testid="warnings-banner"
    >
      <div className="flex items-center gap-1.5 font-semibold text-warning">
        <AlertTriangle className="h-4 w-4" strokeWidth={1.5} />
        {warnings.length} ruleset warning{warnings.length === 1 ? '' : 's'}
      </div>
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((w) => (
          <li key={w.ruleId}>
            <code>{w.ruleId}</code> — {w.reason}{' '}
            <span className="text-text-muted">
              (degraded to {w.degradedTo === 'keyword' ? 'keyword matcher' : 'unrunnable'})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
