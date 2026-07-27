import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../api/client';
import type {
  CliResumeConsent,
  CliResumeReceipt,
  ProviderTarget,
  SanitizationReport,
  SubmissionReceipt,
  SubmitEstimate,
  SubmitMode,
} from '../api/types';
import { AdvancedFold } from './ui/advanced-fold';
import { Button } from './ui/button';

const SELECT_CLASS =
  'ml-2 rounded-md border border-input bg-surface-1 px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

const CONSENT_VERSION = '0.2.0';
const CLI_RESUME_CONSENT_VERSION = 'cli-resume-0.1.0';

interface SubmitPanelProps {
  client: ApiClient;
  reviewId: string;
  gate: SanitizationReport['gate'];
  /**
   * The sealed replay bundle for cli-resume submissions. When provided,
   * cli-resume submit is enabled; when absent, the panel shows a notice that
   * replay preparation is required. Produced by the replay-preparation flow.
   */
  replayBundle?: unknown;
  /** The validated bundle content hash (binds cli-resume consent). */
  bundleContentHash?: string;
  /** Notifies the journey container so it can mark the exit step completed. */
  onSubmitted?: (receipt: SubmissionReceipt | CliResumeReceipt) => void;
  /**
   * Gate the submit behind the journey's one-time donation confirm (design B3).
   * Optional — when absent the panel submits directly (independently usable).
   */
  beforeSubmit?: (proceed: () => void) => void;
}

/**
 * 出口② consent dialog (design: informed consent + full retention). Surfaces
 * target selection, the shown token/cost estimate, the ToS-risk + full-retention
 * disclosure with explicit acknowledgments, and the confirm. Submit is disabled
 * while the gate is locked or either acknowledgment is missing. On confirm it
 * POSTs the submit with a content-bound consent record; the daemon re-runs the
 * pre-send backstop and returns a key-free receipt.
 *
 * Mode selector defaults to `cli-resume` (request-authenticity path via
 * @mosga/replay-submit). The `single-shot` / `turn-by-turn` modes are explicitly
 * labeled as "Compatibility: reconstructed API" and route through
 * @mosga/direct-submit unchanged.
 */
export function SubmitPanel({
  client,
  reviewId,
  gate,
  replayBundle,
  bundleContentHash,
  onSubmitted,
  beforeSubmit,
}: SubmitPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [submitMode, setSubmitMode] = useState<SubmitMode>('cli-resume');
  const [estimate, setEstimate] = useState<SubmitEstimate | null>(null);
  const [ackTos, setAckTos] = useState(false);
  const [ackRetention, setAckRetention] = useState(false);
  const [ackRuntimeContext, setAckRuntimeContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [cliResumeReceipt, setCliResumeReceipt] = useState<CliResumeReceipt | null>(null);

  const isCliResume = submitMode === 'cli-resume';

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
    setCliResumeReceipt(null);
  };

  const onEstimate = async (): Promise<void> => {
    if (!providerId || !model) return;
    setBusy(true);
    setError(null);
    try {
      const mode = isCliResume ? 'single-shot' : submitMode;
      setEstimate(await client.estimateSubmit(reviewId, providerId, model, mode));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // For cli-resume: all three acks + bundle hash. For compat: two acks + estimate.
  const canSubmit = isCliResume
    ? gate.unlocked && !!bundleContentHash && !!replayBundle && ackTos && ackRetention && ackRuntimeContext && !busy
    : gate.unlocked && !!estimate && ackTos && ackRetention && !busy;

  const onSubmit = async (): Promise<void> => {
    if (isCliResume) {
      if (!bundleContentHash || !replayBundle) return;
      setBusy(true);
      setError(null);
      setCliResumeReceipt(null);
      const consent: CliResumeConsent = {
        consentVersion: CLI_RESUME_CONSENT_VERSION,
        tosRiskAcknowledged: ackTos,
        fullRetentionAcknowledged: ackRetention,
        runtimeContextAcknowledged: ackRuntimeContext,
        bundleContentHash: bundleContentHash,
        targetProviderId: providerId,
        targetModel: model,
        replayMode: 'cli-resume',
        instructionPolicy: 'sanitized-snapshot',
        skillPolicy: 'cli-discovery-read-only',
        confirmedAt: new Date().toISOString(),
      };
      const result = await client.submitCliResume(reviewId, {
        providerId,
        model,
        consent,
        bundle: replayBundle,
      });
      setBusy(false);
      if (result.ok) {
        setCliResumeReceipt(result.receipt);
        onSubmitted?.(result.receipt);
      } else {
        const codeMsg = result.code ? ` [${result.code}]` : '';
        setError(`Submit refused${codeMsg} (${result.status}): ${result.error}`);
      }
      return;
    }

    // Compat path (existing behavior).
    if (!estimate) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    const result = await client.submit(reviewId, {
      providerId,
      model,
      replayMode: submitMode,
      consent: {
        consentVersion: CONSENT_VERSION,
        tosRiskAcknowledged: ackTos,
        fullRetentionAcknowledged: ackRetention,
        targetProviderId: providerId,
        targetModel: model,
        replayMode: submitMode,
        estimatedTokens: estimate.totalTokens,
        contentHash: estimate.contentHash,
        confirmedAt: new Date().toISOString(),
      },
    });
    setBusy(false);
    if (result.ok) {
      setReceipt(result.receipt);
      onSubmitted?.(result.receipt);
    } else setError(`Submit refused (${result.status}): ${result.error}`);
  };

  return (
    <div className="space-y-4" data-testid="submit-panel">
      {!gate.unlocked && (
        <div
          className="rounded-md border border-warning/50 bg-warning/10 p-2 text-sm text-foreground"
          data-testid="submit-gate-locked"
        >
          The review gate is locked. Disposition all blocking + non-text items before submitting.
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Provider
          <select
            className={SELECT_CLASS}
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
            className={SELECT_CLASS}
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
            className={SELECT_CLASS}
            data-testid="submit-mode"
            value={submitMode}
            onChange={(e) => {
              const v = e.target.value;
              setSubmitMode(v === 'cli-resume' ? 'cli-resume' : v === 'turn-by-turn' ? 'turn-by-turn' : 'single-shot');
              invalidate();
            }}
          >
            <option value="cli-resume">cli-resume (request-authentic, default)</option>
            <optgroup label="Compatibility: reconstructed API">
              <option value="single-shot">single-shot (linear cost)</option>
              <option value="turn-by-turn">turn-by-turn (quadratic cost)</option>
            </optgroup>
          </select>
        </label>

        {!isCliResume && (
          <Button
            type="button"
            onClick={() => void onEstimate()}
            disabled={busy || !providerId || !model}
            variant="secondary"
            data-testid="submit-estimate-btn"
          >
            Estimate cost
          </Button>
        )}
      </div>

      {isCliResume && (!bundleContentHash || !replayBundle) && (
        <div className="rounded-md border border-warning/50 bg-warning/10 p-2 text-sm text-foreground" data-testid="cli-resume-no-bundle">
          Replay preparation is required before cli-resume submit. Run the replay preparation flow to produce a sealed bundle.
        </div>
      )}

      {estimate && !isCliResume && (
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm" data-testid="submit-estimate">
          <div className="flex flex-wrap gap-4">
            <span>tokens: {estimate.totalTokens.toLocaleString()}</span>
            <span>requests: {estimate.requestCount}</span>
            <span>est. cost: ~${estimate.estimatedCostUsd.toFixed(4)}</span>
          </div>
          <p className="mt-1 text-xs text-text-subtle">
            Token count is authoritative; cost is approximate and provider pricing may differ
            {estimate.pricingSource === 'default' ? ' (generic default pricing — no provider-specific rate)' : ''}.
          </p>
        </div>
      )}

      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
        <p className="font-medium">Before you submit, understand:</p>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={ackTos}
            onChange={(e) => setAckTos(e.target.checked)}
            data-testid="ack-tos"
            className="mt-0.5 accent-primary"
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
            className="mt-0.5 accent-primary"
          />
          <span>
            I understand the FULL session — including my assistant messages — is sent (replay
            requires them), not just my prompts.
          </span>
        </label>
        {isCliResume && (
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              checked={ackRuntimeContext}
              onChange={(e) => setAckRuntimeContext(e.target.checked)}
              data-testid="ack-runtime-context"
              className="mt-0.5 accent-primary"
            />
            <span>
              I understand the source CLI dynamically adds its own system prompt, tool definitions,
              and skill descriptions at runtime, and these are not rescanned by the proxy.
            </span>
          </label>
        )}
      </div>

      <Button
        type="button"
        onClick={() => (beforeSubmit ? beforeSubmit(() => void onSubmit()) : void onSubmit())}
        disabled={!canSubmit}
        size="lg"
        data-testid="submit-confirm"
      >
        {t('submit.confirmButton')}
      </Button>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" data-testid="submit-error">
          {error}
        </div>
      )}

      {/* Cli-resume receipt: three hashes */}
      {cliResumeReceipt && (
        <div className="space-y-3 rounded-md border border-success/50 bg-success/10 p-4" data-testid="cli-resume-receipt">
          <p className="text-sm font-medium text-success">
            已直投 (cli-resume) {cliResumeReceipt.targetProviderId} / {cliResumeReceipt.targetModel} — request authenticity verified.
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">Source CLI</dt>
            <dd className="font-mono">{cliResumeReceipt.sourceCli}</dd>
            <dt className="text-text-muted">Converter</dt>
            <dd className="font-mono">{cliResumeReceipt.converterId} v{cliResumeReceipt.converterVersion}</dd>
            <dt className="text-text-muted">Replay CLI</dt>
            <dd className="font-mono">{cliResumeReceipt.replayCliVersion}</dd>
            <dt className="text-text-muted">Capability</dt>
            <dd className="font-mono">{cliResumeReceipt.capabilityProfileId}</dd>
            <dt className="text-text-muted">HTTP status</dt>
            <dd className="font-mono">{cliResumeReceipt.httpStatus}</dd>
            <dt className="text-text-muted">Outcome</dt>
            <dd className="font-mono">{cliResumeReceipt.outcome}</dd>
          </dl>
          <div className="space-y-1 text-xs">
            <p className="text-text-muted">Three-hash audit trail:</p>
            <div className="space-y-0.5 font-mono text-text-subtle">
              <div><span className="text-text-muted">bundle:</span> {cliResumeReceipt.bundleContentHash}</div>
              <div><span className="text-text-muted">cli-req:</span> {cliResumeReceipt.cliRequestHash}</div>
              <div><span className="text-text-muted">outbound:</span> {cliResumeReceipt.outboundRequestHash}</div>
            </div>
          </div>
          <AdvancedFold label="高级：原始回执 JSON" data-testid="receipt-advanced">
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-text-muted">
              {JSON.stringify(cliResumeReceipt, null, 2)}
            </pre>
          </AdvancedFold>
        </div>
      )}

      {/* Compat receipt (existing display) */}
      {receipt && !isCliResume && (
        <div className="space-y-3 rounded-md border border-success/50 bg-success/10 p-4" data-testid="submit-receipt">
          <p className="text-sm font-medium text-success">
            {t('submit.receiptSummary', { provider: receipt.targetProviderId, model: receipt.targetModel })}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">{t('submit.target')}</dt>
            <dd className="font-mono">{receipt.targetProviderId} / {receipt.targetModel}</dd>
            <dt className="text-text-muted">{t('submit.replayModeLabel')}</dt>
            <dd className="font-mono">{receipt.replayMode}</dd>
          </dl>
          <AdvancedFold label={t('submit.advancedReceipt')} data-testid="receipt-advanced">
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-text-muted">
              {JSON.stringify(receipt, null, 2)}
            </pre>
          </AdvancedFold>
        </div>
      )}
    </div>
  );
}
