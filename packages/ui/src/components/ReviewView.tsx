import { useMemo, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  Disposition,
  NonTextDisposition,
  NormalizationCategory,
  RulesetWarning,
  SanitizationReport,
  SanitizedSession,
} from '../api/types';
import { blockingFindings } from '../lib/findings';
import { ExportPreview } from './ExportPreview';
import { FindingsTable } from './FindingsTable';
import { GateBanner } from './GateBanner';
import { Layer3View } from './Layer3View';
import { makeContextLookup, NonTextList } from './NonTextList';
import { SubmitPanel } from './SubmitPanel';
import { WarningsBanner } from './WarningsBanner';

interface ReviewViewProps {
  client: ApiClient;
  reviewId: string;
  initialReport: SanitizationReport;
  warnings: RulesetWarning[];
  onRestart?: () => void;
}

type Tab = 'blocking' | 'nontext' | 'l3' | 'export' | 'submit';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'blocking', label: 'Blocking findings' },
  { id: 'nontext', label: 'Non-text ⚠' },
  { id: 'l3', label: 'Layer-3 stats' },
  { id: 'export', label: 'Export' },
  { id: 'submit', label: 'Submit (出口②)' },
];

/**
 * The review workspace: rulesetWarnings banner, the confirmation gate + signed
 * summary, and tabbed views for blocking findings, non-text items, L3 stats, and
 * the export preview. Every mutation goes through the daemon and refreshes the
 * held report (so gate counts stay authoritative).
 */
export function ReviewView({
  client,
  reviewId,
  initialReport,
  warnings,
  onRestart,
}: ReviewViewProps): JSX.Element {
  const [report, setReport] = useState<SanitizationReport>(initialReport);
  const [tab, setTab] = useState<Tab>('blocking');
  const [signed, setSigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<SanitizedSession | null>(null);

  const blocking = useMemo(() => blockingFindings(report), [report]);
  const contextFor = useMemo(() => makeContextLookup(report.findings), [report.findings]);

  const run = async (fn: () => Promise<{ report: SanitizationReport }>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { report: next } = await fn();
      setReport(next);
      // A report change can re-lock the gate; drop a stale signature.
      if (!next.gate.unlocked) setSigned(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDisposition = (findingId: string, d: Disposition): void => {
    void run(() => client.setDisposition(reviewId, findingId, d));
  };
  const onBatchByRule = (ruleId: string, d: Disposition): void => {
    void run(() => client.batch(reviewId, 'rule', ruleId, d));
  };
  const onBatchByType = (category: NormalizationCategory, d: Disposition): void => {
    void run(() => client.batch(reviewId, 'type', category, d));
  };
  const onNonText = (messageUuid: string, d: NonTextDisposition): void => {
    void run(() => client.setNonText(reviewId, messageUuid, d));
  };

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.exportReview(reviewId);
      if (result.ok) {
        setExported(result.data.session);
        setTab('export');
      } else {
        setError('Export refused: gate is locked.');
        setReport((r) => ({ ...r, gate: result.gate }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Review · {report.sessionId}</h1>
        {onRestart && (
          <button
            type="button"
            onClick={onRestart}
            className="text-sm text-indigo-600 hover:underline"
            data-testid="restart"
          >
            ← pick another session
          </button>
        )}
      </header>

      <WarningsBanner warnings={warnings} />

      <GateBanner
        gate={report.gate}
        signed={signed}
        onSignedChange={setSigned}
        onExport={() => void onExport()}
        exporting={busy}
      />

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          {error}
        </div>
      )}

      <nav className="flex gap-1 border-b border-gray-200" data-testid="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={`px-3 py-2 text-sm ${
              tab === t.id
                ? 'border-b-2 border-indigo-600 font-medium text-indigo-700'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
            {t.id === 'blocking' && ` (${report.gate.blockingPending})`}
            {t.id === 'nontext' && ` (${report.gate.nonTextPending})`}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'blocking' && (
          <FindingsTable
            findings={blocking}
            onDisposition={onDisposition}
            onBatchByRule={onBatchByRule}
            busy={busy}
          />
        )}
        {tab === 'nontext' && (
          <NonTextList
            items={report.nonTextItems}
            contextFor={contextFor}
            onDisposition={onNonText}
            busy={busy}
          />
        )}
        {tab === 'l3' && <Layer3View report={report} onBatchByType={onBatchByType} busy={busy} />}
        {tab === 'export' && <ExportPreview session={exported} />}
        {tab === 'submit' && <SubmitPanel client={client} reviewId={reviewId} gate={report.gate} />}
      </main>
    </div>
  );
}
