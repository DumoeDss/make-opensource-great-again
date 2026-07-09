import { useMemo } from 'react';

import type { Disposition, NormalizationCategory, SanitizationReport } from '../api/types';
import { describeLocation } from '../lib/findings';
import { Button } from './ui/button';

interface Layer3ViewProps {
  report: SanitizationReport;
  onBatchByType: (category: NormalizationCategory, disposition: Disposition) => void;
  busy?: boolean;
}

/** How many normalization findings to sample per category for spot-checking. */
const SAMPLE_PER_CATEGORY = 5;

/**
 * Layer-3 normalization as statistics + a sampled spot-check (design: L3 does
 * NOT gate). Shows `byCategory` counts and a handful of sampled findings, plus a
 * one-click batch-by-type replace per category — not a per-item gated table.
 */
export function Layer3View({ report, onBatchByType, busy }: Layer3ViewProps): JSX.Element {
  const l3 = useMemo(
    () => report.findings.filter((f) => f.layer === 'normalization'),
    [report.findings],
  );
  const byCategory = report.layerSummary.normalization.byCategory;
  const categories = Object.keys(byCategory);

  const samples = useMemo(() => {
    const out: Record<string, typeof l3> = {};
    for (const cat of categories) {
      out[cat] = l3.filter((f) => f.category === cat).slice(0, SAMPLE_PER_CATEGORY);
    }
    return out;
  }, [l3, categories]);

  if (report.layerSummary.normalization.total === 0) {
    return <p className="text-sm text-text-subtle">No Layer-3 normalization findings.</p>;
  }

  return (
    <div className="space-y-4" data-testid="l3-view">
      <p className="text-sm text-text-muted">
        Layer 3 is statistics + spot-check — it does not block export. Batch-replace a whole
        category, or sample individual hits below.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {categories.map((cat) => (
          <div key={cat} className="rounded-md border border-border bg-surface-1 p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{cat}</span>
              <span className="text-lg font-semibold" data-testid={`l3-count-${cat}`}>
                {byCategory[cat]}
              </span>
            </div>
            <Button
              type="button"
              disabled={busy}
              onClick={() => onBatchByType(cat as NormalizationCategory, 'replace')}
              data-testid={`l3-batch-${cat}`}
              size="xs"
              variant="subtle"
              className="mt-2 w-full"
            >
              batch replace all {cat}
            </Button>
            <ul className="mt-2 space-y-1">
              {samples[cat]?.map((f) => (
                <li key={f.id} className="truncate text-xs text-text-subtle" title={describeLocation(f)}>
                  <code className="font-mono">{f.matchPreview}</code> → {f.replacementSuggestion}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
