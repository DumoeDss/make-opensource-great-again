/**
 * BatchSubmitPanel — the N>1 出口② direct-submit flow (design B4). ONE target
 * selection drives an aggregate estimate and a sequential batch submit over the
 * EXISTING per-review endpoints (zero daemon change):
 *
 *   估算全部 — sequentially `estimateSubmit` each review; aggregate box (总 token /
 *             总成本 / 条数) + a per-item fold. A target change invalidates all.
 *   双重确认 — ONE ToS-risk + full-retention acknowledgment naming the batch size;
 *             each consent record is still content-bound (per-item contentHash).
 *   批量直投 — sequentially `submit` each review with its OWN content-bound consent;
 *             per-item receipt/error + retry. Failures don't stop the loop.
 *
 * `onSubmittedAll` fires only once EVERY review has a successful receipt (the
 * journey's 已完成 state). Sequential, never parallel — one local daemon + external
 * providers; sequential keeps progress honest and avoids rate bursts.
 */
import { useEffect, useRef, useState } from 'react';

import type { ApiClient } from '../../api/client';
import type { ProviderTarget, ReplayMode, SubmissionReceipt, SubmitEstimate } from '../../api/types';
import { AdvancedFold } from '../ui/advanced-fold';
import { Button } from '../ui/button';

const SELECT_CLASS =
  'ml-2 rounded-md border border-input bg-surface-1 px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

const CONSENT_VERSION = '0.2.0';

/** A signed review to direct-submit (title for display, sessionId for testids). */
export interface BatchSubmitItem {
  reviewId: string;
  sessionId: string;
  title: string;
}

interface BatchSubmitPanelProps {
  client: ApiClient;
  items: BatchSubmitItem[];
  /** Fires once every item has a successful receipt → the journey's 已完成 state. */
  onSubmittedAll: () => void;
  /**
   * Gate the batch run behind the journey's one-time donation confirm (design B3).
   * Optional — absent = run directly. Per-item retries are NOT gated (by then the
   * confirm has already been given).
   */
  beforeRun?: (proceed: () => void) => void;
}

type ItemResult = { ok: true; receipt: SubmissionReceipt } | { ok: false; error: string };

export function BatchSubmitPanel({ client, items, onSubmittedAll, beforeRun }: BatchSubmitPanelProps): JSX.Element {
  const [providers, setProviders] = useState<ProviderTarget[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [replayMode, setReplayMode] = useState<ReplayMode>('single-shot');
  const [estimates, setEstimates] = useState<Record<string, SubmitEstimate>>({});
  const [estimating, setEstimating] = useState(false);
  const [estimateProgress, setEstimateProgress] = useState<{ k: number; n: number } | null>(null);
  const [ackTos, setAckTos] = useState(false);
  const [ackRetention, setAckRetention] = useState(false);
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<{ k: number; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped on any target change so an in-flight estimate loop can abort itself.
  const genRef = useRef(0);
  // Ensures `onSubmittedAll` fires at most once per completion.
  const firedRef = useRef(false);

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
  const allEstimated = items.length > 0 && items.every((i) => estimates[i.reviewId]);

  // Any change to the target/model/mode invalidates every estimate + result.
  const invalidate = (): void => {
    genRef.current += 1;
    firedRef.current = false;
    setEstimates({});
    setResults({});
  };

  // Completion: fire once when every item carries a successful receipt.
  useEffect(() => {
    if (firedRef.current) return;
    if (items.length > 0 && items.every((i) => results[i.reviewId]?.ok)) {
      firedRef.current = true;
      onSubmittedAll();
    }
  }, [results, items, onSubmittedAll]);

  const onEstimateAll = async (): Promise<void> => {
    if (!providerId || !model) return;
    const gen = genRef.current;
    setEstimating(true);
    setError(null);
    const next: Record<string, SubmitEstimate> = {};
    for (let i = 0; i < items.length; i += 1) {
      if (genRef.current !== gen) break; // target changed mid-loop → abort
      setEstimateProgress({ k: i + 1, n: items.length });
      try {
        next[items[i].reviewId] = await client.estimateSubmit(items[i].reviewId, providerId, model, replayMode);
      } catch (e) {
        setError(String(e));
        setEstimating(false);
        setEstimateProgress(null);
        return;
      }
    }
    if (genRef.current === gen) setEstimates(next);
    setEstimating(false);
    setEstimateProgress(null);
  };

  const submitItem = async (item: BatchSubmitItem, est: SubmitEstimate): Promise<void> => {
    const result = await client.submit(item.reviewId, {
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
        estimatedTokens: est.totalTokens,
        // Each consent is bound to THIS review's exact content hash.
        contentHash: est.contentHash,
        confirmedAt: new Date().toISOString(),
      },
    });
    setResults((prev) => ({
      ...prev,
      [item.reviewId]: result.ok
        ? { ok: true, receipt: result.receipt }
        : { ok: false, error: `${result.status}: ${result.error}` },
    }));
  };

  const canRun = allEstimated && ackTos && ackRetention && !running && !estimating;

  const onRunAll = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      setRunProgress({ k: i + 1, n: items.length });
      if (results[item.reviewId]?.ok) continue; // already succeeded (retry-all)
      const est = estimates[item.reviewId];
      if (!est) continue;
      await submitItem(item, est); // failures are captured per item, never thrown
    }
    setRunning(false);
    setRunProgress(null);
  };

  const onRetry = async (item: BatchSubmitItem): Promise<void> => {
    const est = estimates[item.reviewId];
    if (!est) return;
    setError(null);
    await submitItem(item, est);
  };

  const totalTokens = items.reduce((n, i) => n + (estimates[i.reviewId]?.totalTokens ?? 0), 0);
  const totalCost = items.reduce((n, i) => n + (estimates[i.reviewId]?.estimatedCostUsd ?? 0), 0);

  return (
    <div className="space-y-4" data-testid="batch-submit-panel">
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Provider
          <select
            className={SELECT_CLASS}
            data-testid="batch-submit-provider"
            value={providerId}
            disabled={running}
            onChange={(e) => {
              const id = e.target.value;
              setProviderId(id);
              setModel(providers.find((x) => x.id === id)?.models[0] ?? '');
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
            data-testid="batch-submit-model"
            value={model}
            disabled={running}
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
            data-testid="batch-submit-mode"
            value={replayMode}
            disabled={running}
            onChange={(e) => {
              setReplayMode(e.target.value === 'turn-by-turn' ? 'turn-by-turn' : 'single-shot');
              invalidate();
            }}
          >
            <option value="single-shot">single-shot (recommended, linear cost)</option>
            <option value="turn-by-turn">turn-by-turn (opt-in, quadratic cost)</option>
          </select>
        </label>

        <Button
          type="button"
          onClick={() => void onEstimateAll()}
          disabled={estimating || !providerId || !model}
          variant="secondary"
          data-testid="batch-estimate-all"
        >
          {estimating ? `估算中 ${estimateProgress?.k ?? 0}/${estimateProgress?.n ?? items.length}…` : '估算全部'}
        </Button>
      </div>

      {allEstimated && (
        <div className="rounded-md border border-border bg-surface-1 p-3 text-sm" data-testid="batch-estimate">
          <div className="flex flex-wrap gap-4">
            <span>总 token：{totalTokens.toLocaleString()}</span>
            <span>总成本：~${totalCost.toFixed(4)}</span>
            <span>共 {items.length} 条</span>
          </div>
          <p className="mt-1 text-xs text-text-subtle">Token 计数为准；成本为近似，各服务商定价可能不同。</p>
          <AdvancedFold label="高级：逐条估算" data-testid="batch-estimate-detail">
            <table className="w-full text-left text-xs">
              <thead className="text-text-muted">
                <tr>
                  <th className="py-1 pr-3 font-medium">会话</th>
                  <th className="py-1 pr-3 font-medium">token</th>
                  <th className="py-1 font-medium">~成本</th>
                </tr>
              </thead>
              <tbody className="font-mono text-text-subtle">
                {items.map((i) => {
                  const est = estimates[i.reviewId];
                  return (
                    <tr key={i.reviewId}>
                      <td className="py-1 pr-3">{i.sessionId}</td>
                      <td className="py-1 pr-3">{est?.totalTokens.toLocaleString() ?? '—'}</td>
                      <td className="py-1">~${(est?.estimatedCostUsd ?? 0).toFixed(4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </AdvancedFold>
        </div>
      )}

      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
        <p className="font-medium">批量直投以下 {items.length} 个会话前，请确认：</p>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={ackTos}
            onChange={(e) => setAckTos(e.target.checked)}
            data-testid="batch-ack-tos"
            className="mt-0.5 accent-primary"
          />
          <span>
            我理解将这些会话发送给第三方服务商可能受其服务条款约束，并接受该风险。
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2">
          <input
            type="checkbox"
            checked={ackRetention}
            onChange={(e) => setAckRetention(e.target.checked)}
            data-testid="batch-ack-retention"
            className="mt-0.5 accent-primary"
          />
          <span>
            我理解每个会话的完整内容（含我的助手消息，回放所需）都会被发送，而非仅我的提问。
          </span>
        </label>
      </div>

      <Button
        type="button"
        onClick={() => (beforeRun ? beforeRun(() => void onRunAll()) : void onRunAll())}
        disabled={!canRun}
        size="lg"
        data-testid="batch-submit-run"
      >
        {running ? `直投中 ${runProgress?.k ?? 0}/${runProgress?.n ?? items.length}…` : `批量直投 ${items.length} 条`}
      </Button>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" data-testid="batch-submit-error">
          {error}
        </div>
      )}

      {Object.keys(results).length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => {
            const r = results[item.reviewId];
            if (!r) return null;
            return (
              <li
                key={item.reviewId}
                className="rounded-md border border-border bg-surface-1 p-3 text-sm"
                data-testid={`batch-submit-result-${item.sessionId}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate" title={item.title}>
                    {item.title}
                  </span>
                  {r.ok ? (
                    <span className="shrink-0 text-success">
                      已直投 {r.receipt.targetProviderId} / {r.receipt.targetModel}
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-destructive">失败：{r.error}</span>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        onClick={() => void onRetry(item)}
                        data-testid={`batch-submit-retry-${item.sessionId}`}
                      >
                        重试
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
