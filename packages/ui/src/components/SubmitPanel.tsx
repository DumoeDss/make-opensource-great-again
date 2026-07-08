import { useEffect, useState } from 'react';

import type { ApiClient } from '../api/client';
import type {
  ProviderTarget,
  ReplayMode,
  SanitizationReport,
  SubmissionReceipt,
  SubmitEstimate,
} from '../api/types';

const CONSENT_VERSION = '0.2.0';

interface SubmitPanelProps {
  client: ApiClient;
  reviewId: string;
  gate: SanitizationReport['gate'];
}

/**
 * 出口② consent dialog (design: informed consent + full retention). Surfaces
 * target selection, the shown token/cost estimate, the ToS-risk + full-retention
 * disclosure with explicit acknowledgments, and the confirm. Submit is disabled
 * while the gate is locked or either acknowledgment is missing. On confirm it
 * POSTs the submit with a content-bound consent record; the daemon re-runs the
 * pre-send backstop and returns a key-free receipt.
 */
export function SubmitPanel({ client, reviewId, gate }: SubmitPanelProps): JSX.Element {
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [replayMode, setReplayMode] = useState<ReplayMode>('single-shot');
  const [estimate, setEstimate] = useState<SubmitEstimate | null>(null);
  const [ackTos, setAckTos] = useState(false);
  const [ackRetention, setAckRetention] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);

  useEffect(() => {
    let active = true;
    client
      .listProviders()
      .then((list) => {
        if (!active) return;
        setProviders(list);
        if (list.length > 0) {
          setProviderId(list[0].id);
          setModel(list[0].models[0] ?? '');
        }
      })
      .catch((e: unknown) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [client]);

  const selected = providers.find((p) => p.id === providerId);

  // Any change to the target/model/mode invalidates a shown estimate + consent.
  const invalidate = (): void => {
    setEstimate(null);
    setReceipt(null);
  };

  const onEstimate = async (): Promise<void> => {
    if (!providerId || !model) return;
    setBusy(true);
    setError(null);
    try {
      setEstimate(await client.estimateSubmit(reviewId, providerId, model, replayMode));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = gate.unlocked && !!estimate && ackTos && ackRetention && !busy;

  const onSubmit = async (): Promise<void> => {
    if (!estimate) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    const result = await client.submit(reviewId, {
      providerId,
      model,
      replayMode,
      consent: {
        consentVersion: CONSENT_VERSION,
        tosRiskAcknowledged: ackTos,
        fullRetentionAcknowledged: ackRetention,
        targetProviderId: providerId,
        targetModel: model,
        replayMode,
        estimatedTokens: estimate.totalTokens,
        contentHash: estimate.contentHash,
        confirmedAt: new Date().toISOString(),
      },
    });
    setBusy(false);
    if (result.ok) setReceipt(result.receipt);
    else setError(`Submit refused (${result.status}): ${result.error}`);
  };

  return (
    <div className="space-y-4" data-testid="submit-panel">
      {!gate.unlocked && (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800"
          data-testid="submit-gate-locked"
        >
          The review gate is locked. Disposition all blocking + non-text items before submitting.
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Provider
          <select
            className="ml-2 rounded border border-gray-300 px-2 py-1"
            data-testid="submit-provider"
            value={providerId}
            onChange={(e) => {
              const id = e.target.value;
              setProviderId(id);
              const p = providers.find((x) => x.id === id);
              setModel(p?.models[0] ?? '');
              invalidate();
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.apiFormat})
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          Model
          <select
            className="ml-2 rounded border border-gray-300 px-2 py-1"
            data-testid="submit-model"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              invalidate();
            }}
          >
            {(selected?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          Mode
          <select
            className="ml-2 rounded border border-gray-300 px-2 py-1"
            data-testid="submit-mode"
            value={replayMode}
            onChange={(e) => {
              setReplayMode(e.target.value === 'turn-by-turn' ? 'turn-by-turn' : 'single-shot');
              invalidate();
            }}
          >
            <option value="single-shot">single-shot (recommended, linear cost)</option>
            <option value="turn-by-turn">turn-by-turn (opt-in, quadratic cost)</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => void onEstimate()}
          disabled={busy || !providerId || !model}
          className="rounded bg-gray-800 px-3 py-1 text-sm text-white disabled:opacity-50"
          data-testid="submit-estimate-btn"
        >
          Estimate cost
        </button>
      </div>

      {estimate && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="submit-estimate">
          <div className="flex flex-wrap gap-4">
            <span>tokens: {estimate.totalTokens.toLocaleString()}</span>
            <span>requests: {estimate.requestCount}</span>
            <span>est. cost: ~${estimate.estimatedCostUsd.toFixed(4)}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Token count is authoritative; cost is approximate and provider pricing may differ
            {estimate.pricingSource === 'default' ? ' (generic default pricing — no provider-specific rate)' : ''}.
          </p>
        </div>
      )}

      <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
        <p className="font-medium">Before you submit, understand:</p>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={ackTos}
            onChange={(e) => setAckTos(e.target.checked)}
            data-testid="ack-tos"
          />
          <span>
            I understand that sending this session to a third-party provider may be subject to that
            provider&apos;s Terms of Service, and I accept that risk.
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={ackRetention}
            onChange={(e) => setAckRetention(e.target.checked)}
            data-testid="ack-retention"
          />
          <span>
            I understand the FULL session — including my assistant messages — is sent (replay
            requires them), not just my prompts.
          </span>
        </label>
      </div>

      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={!canSubmit}
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-testid="submit-confirm"
      >
        Confirm &amp; submit (出口②)
      </button>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800" data-testid="submit-error">
          {error}
        </div>
      )}

      {receipt && (
        <div data-testid="submit-receipt">
          <p className="mb-1 text-sm font-medium text-green-800">
            Submitted to {receipt.targetProviderId} / {receipt.targetModel} — backstop passed.
          </p>
          <pre className="max-h-72 overflow-auto rounded bg-gray-900 p-3 text-xs text-gray-100">
            {JSON.stringify(receipt, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
