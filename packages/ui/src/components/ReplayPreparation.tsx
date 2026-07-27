/**
 * Replay preparation flow: prepare → triage → seal.
 *
 * Drives the daemon-side replay-bundle pipeline and produces the sealed
 * `ReplayBundle` + validated content hash that `SubmitPanel`'s cli-resume mode
 * consumes. The flow runs alongside the existing normalized review (same
 * compiled ruleset; the replay path scans native JSONL + instruction content).
 *
 * The bundle's delivery target is chosen here and sealed into the bundle; the
 * cli-resume consent must match it exactly (the orchestration validates this).
 */
import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  ProviderTarget,
  ReplayFinding,
  ReplayFindingDisposition,
  ReplayOpaqueDisposition,
  ReplayOpaqueItem,
  ReplayPrepareResponse,
  ReplaySanitizationReport,
} from '../api/types';
import { AdvancedFold } from './ui/advanced-fold';
import { Button } from './ui/button';

const SELECT_CLASS =
  'ml-2 rounded-md border border-input bg-surface-1 px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

interface ReplayPreparationProps {
  client: ApiClient;
  reviewId: string;
  /**
   * Called when the replay bundle is sealed. The parent passes `bundle` +
   * `bundleContentHash` to `SubmitPanel` so cli-resume submit is enabled.
   */
  onSealed: (bundle: unknown, bundleContentHash: string) => void;
}

type Phase = 'idle' | 'preparing' | 'reviewing' | 'sealed';

/**
 * The replay-preparation card. Rendered inside the 出口② section above the
 * `SubmitPanel`. When sealed, the bundle flows into `SubmitPanel` via props.
 */
export function ReplayPreparation({
  client,
  reviewId,
  onSealed,
}: ReplayPreparationProps): JSX.Element {
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [sealing, setSealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<ReplayPrepareResponse | null>(null);
  const [report, setReport] = useState<ReplaySanitizationReport | null>(null);
  const [sealedHash, setSealedHash] = useState<string | null>(null);

  // Load providers on mount (same pattern as SubmitPanel). Default to the first
  // provider's first model so the user can prepare immediately.
  useEffect(() => {
    let active = true;
    client
      .listProviders()
      .then((list) => {
        if (!active) return;
        setProviders(list);
        if (list.length > 0) {
          setProviderId(list[0]!.id);
          setModel(list[0]!.models[0] ?? '');
        }
      })
      .catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [client]);

  const onPrepare = async (): Promise<void> => {
    setPhase('preparing');
    setError(null);
    try {
      if (!providerId || !model) {
        setError('Select a target provider and model first.');
        setPhase('idle');
        return;
      }
      const res = await client.prepareReplay(reviewId, {
        targetProviderId: providerId,
        targetModel: model,
      });
      setPrepared(res);
      setReport(res.report);
      setPhase('reviewing');
    } catch (e) {
      setError(String(e));
      setPhase('idle');
    }
  };

  const onFindingDisposition = async (
    finding: ReplayFinding,
    disposition: ReplayFindingDisposition,
  ): Promise<void> => {
    if (!report) return;
    try {
      const res = await client.setReplayFindingDisposition(reviewId, finding.id, disposition);
      setReport(res.report);
    } catch (e) {
      setError(String(e));
    }
  };

  const onOpaqueDisposition = async (
    item: ReplayOpaqueItem,
    disposition: ReplayOpaqueDisposition,
  ): Promise<void> => {
    if (!report) return;
    try {
      const res = await client.setReplayOpaqueDisposition(reviewId, item.id, disposition);
      setReport(res.report);
    } catch (e) {
      setError(String(e));
    }
  };

  const onSeal = async (): Promise<void> => {
    setSealing(true);
    setError(null);
    try {
      const res = await client.sealReplay(reviewId);
      if (res.ok) {
        setSealedHash(res.data.bundleContentHash);
        setPhase('sealed');
        onSealed(res.data.bundle, res.data.bundleContentHash);
      } else {
        const codeMsg = res.code ? ` [${res.code}]` : '';
        setError(`Seal refused${codeMsg} (${res.status}): ${res.error}`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSealing(false);
    }
  };

  const gate = report?.gate;
  const blockingPending = gate?.blockingPending ?? 0;
  const opaquePending = gate?.opaquePending ?? 0;
  const canSeal = !!gate?.unlocked && phase === 'reviewing' && !sealing;

  if (phase === 'sealed') {
    return (
      <div
        className="rounded-md border border-success/50 bg-success/10 p-3 text-sm text-foreground"
        data-testid="replay-prep-sealed"
      >
        <p className="font-medium text-success">
          Replay bundle sealed — cli-resume submit is enabled.
        </p>
        <p className="mt-1 font-mono text-xs text-text-subtle">{sealedHash}</p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1"
          onClick={() => {
            setPhase('idle');
            setPrepared(null);
            setReport(null);
            setSealedHash(null);
          }}
          data-testid="replay-prep-reset"
        >
          Re-prepare
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3" data-testid="replay-prep">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">Replay preparation (cli-resume)</h4>
        {phase === 'reviewing' && gate && (
          <span
            className={`text-xs ${gate.unlocked ? 'text-success' : 'text-warning'}`}
            data-testid="replay-prep-gate"
          >
            gate: {gate.unlocked ? 'unlocked' : `blocking=${blockingPending} opaque=${opaquePending}`}
          </span>
        )}
      </div>

      {(phase === 'idle' || phase === 'preparing') && (
        <>
          <p className="text-xs text-text-muted">
            Capture the native session, scan it, review findings, and seal a replay bundle for
            cli-resume submit. The bundle is bound to the chosen target.
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs">
              Provider
              <select
                className={SELECT_CLASS}
                data-testid="replay-prep-provider"
                value={providerId}
                onChange={(e) => {
                  const id = e.target.value;
                  setProviderId(id);
                  const p = providers.find((x) => x.id === id);
                  setModel(p?.models[0] ?? '');
                }}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              Model
              <select
                className={SELECT_CLASS}
                data-testid="replay-prep-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {(providers.find((p) => p.id === providerId)?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void onPrepare()}
            disabled={phase === 'preparing'}
            data-testid="replay-prep-prepare-btn"
          >
            {phase === 'preparing' ? 'Preparing…' : 'Prepare replay bundle'}
          </Button>
        </>
      )}

      {phase === 'reviewing' && report && (
        <>
          {prepared && (
            <div className="text-xs text-text-subtle" data-testid="replay-prep-summary">
              Source: {prepared.source.sourceCli} · Trajectory: {prepared.trajectory.userTurns}u /{' '}
              {prepared.trajectory.assistantTurns}a · Findings: {report.findings.length} · Opaque: {report.opaqueItems.length}
            </div>
          )}

          {report.findings.length > 0 && (
            <div data-testid="replay-prep-findings">
              <p className="text-xs font-medium text-text-muted">Replay findings</p>
              <div className="mt-1 space-y-1">
                {report.findings.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono text-text-subtle" title={f.ruleId}>
                      {f.ruleId}
                      {f.blocking ? ' ⚠' : ''}
                    </span>
                    <select
                      className={SELECT_CLASS}
                      data-testid={`replay-finding-${f.id}-disposition`}
                      value={f.disposition}
                      onChange={(e) =>
                        void onFindingDisposition(
                          f,
                          e.target.value as ReplayFindingDisposition,
                        )
                      }
                    >
                      <option value="pending">pending</option>
                      <option value="replace">replace</option>
                      <option value="delete">delete</option>
                      <option value="allow">allow</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.opaqueItems.length > 0 && (
            <div data-testid="replay-prep-opaque">
              <p className="text-xs font-medium text-text-muted">Opaque / non-text blocks</p>
              <div className="mt-1 space-y-1">
                {report.opaqueItems.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-mono text-text-subtle" title={item.blockType}>
                      {item.blockType}
                    </span>
                    <select
                      className={SELECT_CLASS}
                      data-testid={`replay-opaque-${item.id}-disposition`}
                      value={item.disposition}
                      onChange={(e) =>
                        void onOpaqueDisposition(
                          item,
                          e.target.value as ReplayOpaqueDisposition,
                        )
                      }
                    >
                      <option value="pending">pending</option>
                      <option value="keep">keep</option>
                      <option value="remove">remove</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.findings.length === 0 && report.opaqueItems.length === 0 && (
            <p className="text-xs text-success" data-testid="replay-prep-clean">
              Scan clean — no findings or opaque items. Ready to seal.
            </p>
          )}

          {prepared && prepared.rulesetWarnings.length > 0 && (
            <AdvancedFold label={`Ruleset warnings (${prepared.rulesetWarnings.length})`} data-testid="replay-prep-warnings">
              <ul className="space-y-0.5 text-xs text-text-subtle">
                {prepared.rulesetWarnings.map((w) => (
                  <li key={w.ruleId} className="font-mono">
                    {w.ruleId}: {w.reason} (→ {w.degradedTo})
                  </li>
                ))}
              </ul>
            </AdvancedFold>
          )}

          <Button
            type="button"
            size="sm"
            onClick={() => void onSeal()}
            disabled={!canSeal}
            data-testid="replay-prep-seal-btn"
          >
            {sealing ? 'Sealing…' : 'Seal replay bundle'}
          </Button>
        </>
      )}

      {error && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="replay-prep-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}
