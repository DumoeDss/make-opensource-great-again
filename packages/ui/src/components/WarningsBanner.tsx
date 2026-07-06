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
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      data-testid="warnings-banner"
    >
      <div className="font-semibold">
        ⚠ {warnings.length} ruleset warning{warnings.length === 1 ? '' : 's'}
      </div>
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((w) => (
          <li key={w.ruleId}>
            <code>{w.ruleId}</code> — {w.reason}{' '}
            <span className="text-amber-700">
              (degraded to {w.degradedTo === 'keyword' ? 'keyword matcher' : 'unrunnable'})
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
