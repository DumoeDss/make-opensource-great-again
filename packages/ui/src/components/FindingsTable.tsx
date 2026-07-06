import { useMemo, useState } from 'react';

import type { Disposition, Finding } from '../api/types';
import { describeLocation, distinctRuleIds, isMetaFinding } from '../lib/findings';

interface FindingsTableProps {
  /** Blocking findings only (secrets + custom + engine/meta). */
  findings: Finding[];
  onDisposition: (findingId: string, disposition: Disposition) => void;
  onBatchByRule: (ruleId: string, disposition: Disposition) => void;
  busy?: boolean;
}

const PAGE_SIZE = 100;

const DISPOSITION_LABEL: Record<Disposition, string> = {
  pending: 'pending',
  replace: 'replace',
  delete: 'delete',
  allow: 'allow',
};

function DispositionButtons({
  finding,
  onDisposition,
  busy,
}: {
  finding: Finding;
  onDisposition: (findingId: string, disposition: Disposition) => void;
  busy?: boolean;
}): JSX.Element {
  // A meta finding has no editable text — only acknowledge (allow) clears it.
  if (isMetaFinding(finding)) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => onDisposition(finding.id, 'allow')}
        data-testid={`ack-${finding.id}`}
        className={`rounded px-2 py-1 text-xs font-medium ${
          finding.disposition === 'allow'
            ? 'bg-blue-600 text-white'
            : 'border border-blue-400 text-blue-700 hover:bg-blue-50'
        }`}
      >
        {finding.disposition === 'allow' ? 'acknowledged' : 'acknowledge (reviewed)'}
      </button>
    );
  }
  const options: Disposition[] = ['replace', 'delete', 'allow'];
  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          disabled={busy}
          onClick={() => onDisposition(finding.id, opt)}
          data-testid={`disp-${finding.id}-${opt}`}
          className={`rounded px-2 py-1 text-xs ${
            finding.disposition === opt
              ? 'bg-gray-800 text-white'
              : 'border border-gray-300 text-gray-700 hover:bg-gray-100'
          }`}
        >
          {DISPOSITION_LABEL[opt]}
        </button>
      ))}
    </div>
  );
}

/**
 * The blocking findings table: layer / rule / structural position / redacted
 * preview + a per-hit disposition control. Only the redacted `matchPreview` is
 * shown — never a raw secret. Filterable by layer, paginated for large lists.
 */
export function FindingsTable({
  findings,
  onDisposition,
  onBatchByRule,
  busy,
}: FindingsTableProps): JSX.Element {
  const [layerFilter, setLayerFilter] = useState<'all' | Finding['layer']>('all');
  const [page, setPage] = useState(0);

  const filtered = useMemo(
    () => (layerFilter === 'all' ? findings : findings.filter((f) => f.layer === layerFilter)),
    [findings, layerFilter],
  );
  const ruleIds = useMemo(() => distinctRuleIds(filtered), [filtered]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div data-testid="findings-table">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="text-sm">
          Layer:{' '}
          <select
            value={layerFilter}
            onChange={(e) => {
              setLayerFilter(e.target.value as 'all' | Finding['layer']);
              setPage(0);
            }}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            data-testid="layer-filter"
          >
            <option value="all">all</option>
            <option value="secrets">secrets (L1)</option>
            <option value="custom">custom (L2)</option>
          </select>
        </label>
        <span className="text-sm text-gray-500">
          {filtered.length} blocking finding{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {ruleIds.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" data-testid="batch-by-rule">
          {ruleIds.map((ruleId) => (
            <button
              key={ruleId}
              type="button"
              disabled={busy}
              onClick={() => onBatchByRule(ruleId, 'replace')}
              data-testid={`batch-rule-${ruleId}`}
              className="rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-xs text-indigo-800 hover:bg-indigo-100"
            >
              batch replace all “{ruleId}”
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Layer</th>
              <th className="px-3 py-2">Rule</th>
              <th className="px-3 py-2">Position</th>
              <th className="px-3 py-2">Redacted preview</th>
              <th className="px-3 py-2">Disposition</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.id} className="border-t border-gray-100" data-testid={`finding-row-${f.id}`}>
                <td className="px-3 py-2 align-top">{f.layer}</td>
                <td className="px-3 py-2 align-top font-mono text-xs">{f.ruleId}</td>
                <td className="px-3 py-2 align-top font-mono text-xs text-gray-600">
                  {describeLocation(f)}
                </td>
                <td className="px-3 py-2 align-top">
                  <code className="break-all text-xs">{f.matchPreview}</code>
                </td>
                <td className="px-3 py-2 align-top">
                  <DispositionButtons finding={f} onDisposition={onDisposition} busy={busy} />
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-gray-500" colSpan={5}>
                  No blocking findings.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-2 flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            Prev
          </button>
          <span>
            Page {clampedPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage >= pageCount - 1}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
