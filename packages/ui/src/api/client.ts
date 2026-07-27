/**
 * Typed same-origin API client. The daemon serves this UI at `/ui`, so every
 * call is a relative `/api/...` URL — no host, no CORS.
 */
import type {
  CliResumeConsent,
  CliResumeReceipt,
  ContributionConsent,
  CreateReviewResponse,
  CustomProviderInput,
  Disposition,
  ExportResponse,
  HealthResponse,
  KeyStatusMap,
  NonTextDisposition,
  NormalizationCategory,
  ProjectsResponse,
  ProviderTarget,
  PublishBatchPlan,
  PublishBatchStageResult,
  PublishBatchSubmitResult,
  PublishError,
  PublishPlan,
  PublishPreflight,
  PublishStageResult,
  PublishSubmitResult,
  ReplayFindingDisposition,
  ReplayMode,
  ReplayOpaqueDisposition,
  ReplayPrepareResponse,
  ReplayReportResponse,
  ReplaySealResponse,
  ReportResponse,
  SanitizationReport,
  SessionRef,
  SourceRef,
  SubmissionReceipt,
  SubmitEstimate,
} from './types';

/** A publish call result: success payload, or a typed `{ code, error, ... }`. */
export type PublishResult<T> = ({ ok: true } & T) | ({ ok: false } & PublishError);

export interface ApiClient {
  getHealth(): Promise<HealthResponse>;
  listSources(): Promise<SourceRef[]>;
  listProjects(sourceId: string, showAll: boolean): Promise<ProjectsResponse>;
  listSessions(sourceId: string, projectKey: string): Promise<SessionRef[]>;
  createReview(sourceId: string, projectKey: string, sessionId: string): Promise<CreateReviewResponse>;
  setDisposition(reviewId: string, findingId: string, disposition: Disposition): Promise<ReportResponse>;
  batch(
    reviewId: string,
    by: 'rule' | 'type',
    key: string,
    disposition: Disposition,
  ): Promise<ReportResponse>;
  setNonText(
    reviewId: string,
    messageUuid: string,
    disposition: NonTextDisposition,
  ): Promise<ReportResponse>;
  getGate(reviewId: string): Promise<SanitizationReport['gate']>;
  exportReview(reviewId: string): Promise<{ ok: true; data: ExportResponse } | { ok: false; gate: SanitizationReport['gate'] }>;
  listProviders(): Promise<ProviderTarget[]>;
  /** List only the user-added custom providers (the editable subset). */
  listCustomProviders(): Promise<ProviderTarget[]>;
  /** Create a custom provider (key-free); rejects on id conflict / validation error. */
  createCustomProvider(input: CustomProviderInput): Promise<ProviderTarget>;
  /** Update a custom provider's fields (id is immutable). */
  updateCustomProvider(id: string, fields: Omit<CustomProviderInput, 'id'>): Promise<ProviderTarget>;
  /** Delete a custom provider. */
  deleteCustomProvider(id: string): Promise<void>;
  /** Per-provider key status (`configured` boolean only — never key bytes). */
  getKeyStatus(): Promise<KeyStatusMap>;
  /** Set a provider's API key (write-only; the value is never read back). */
  setProviderKey(providerId: string, apiKey: string): Promise<void>;
  /** Clear a provider's API key. */
  clearProviderKey(providerId: string): Promise<void>;
  estimateSubmit(reviewId: string, providerId: string, model: string, replayMode: ReplayMode): Promise<SubmitEstimate>;
  submit(
    reviewId: string,
    body: { providerId: string; model: string; replayMode: ReplayMode; consent: ContributionConsent },
  ): Promise<{ ok: true; receipt: SubmissionReceipt } | { ok: false; status: number; error: string }>;
  /** Cli-resume submit (出口② request-authenticity path). Sends the sealed bundle. */
  submitCliResume(
    reviewId: string,
    body: { providerId: string; model: string; consent: CliResumeConsent; bundle: unknown },
  ): Promise<{ ok: true; receipt: CliResumeReceipt } | { ok: false; status: number; error: string; code?: string }>;
  /**
   * Replay preparation: capture the native session, build a replay draft, scan
   * it, and return the replay scan report for triage. The daemon holds the
   * draft + mapper + ruleset server-side for the seal step.
   */
  prepareReplay(
    reviewId: string,
    target: { targetProviderId: string; targetModel: string },
  ): Promise<ReplayPrepareResponse>;
  /** Set a replay finding's disposition (pending / replace / delete / allow). */
  setReplayFindingDisposition(
    reviewId: string,
    findingId: string,
    disposition: ReplayFindingDisposition,
  ): Promise<ReplayReportResponse>;
  /** Set a replay opaque item's disposition (pending / keep / remove / replace). */
  setReplayOpaqueDisposition(
    reviewId: string,
    itemId: string,
    disposition: ReplayOpaqueDisposition,
    replacement?: unknown,
  ): Promise<ReplayReportResponse>;
  /**
   * Seal the reviewed replay draft → the sealed `ReplayBundle` the cli-resume
   * submit consumes. Requires an unlocked replay gate.
   */
  sealReplay(
    reviewId: string,
  ): Promise<{ ok: true; data: ReplaySealResponse } | { ok: false; status: number; error: string; code?: string; gate?: SanitizationReport['gate'] }>;
  getPreflight(): Promise<PublishPreflight>;
  publishPlan(reviewId: string): Promise<PublishResult<{ plan: PublishPlan }>>;
  publishStage(reviewId: string): Promise<PublishResult<{ result: PublishStageResult }>>;
  publishSubmit(reviewId: string): Promise<PublishResult<{ result: PublishSubmitResult }>>;
  /** Batch 出口① over `/api/publish/batch/*` — N reviews as one branch/commit/PR. */
  publishBatchPlan(reviewIds: string[]): Promise<PublishResult<{ plan: PublishBatchPlan }>>;
  publishBatchStage(reviewIds: string[]): Promise<PublishResult<{ result: PublishBatchStageResult }>>;
  publishBatchSubmit(reviewIds: string[]): Promise<PublishResult<{ result: PublishBatchSubmitResult }>>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function send(method: 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const apiClient: ApiClient = {
  async getHealth() {
    return json<HealthResponse>(await fetch('/api/health'));
  },
  async listSources() {
    const data = await json<{ sources: SourceRef[] }>(await fetch('/api/sources'));
    return data.sources;
  },
  async listProjects(sourceId, showAll) {
    const q = showAll ? '?all=1' : '';
    return json<ProjectsResponse>(
      await fetch(`/api/sources/${encodeURIComponent(sourceId)}/projects${q}`),
    );
  },
  async listSessions(sourceId, projectKey) {
    const data = await json<{ sessions: SessionRef[] }>(
      await fetch(
        `/api/sources/${encodeURIComponent(sourceId)}/projects/${encodeURIComponent(projectKey)}/sessions`,
      ),
    );
    return data.sessions;
  },
  async createReview(sourceId, projectKey, sessionId) {
    return json<CreateReviewResponse>(await post('/api/reviews', { sourceId, projectKey, sessionId }));
  },
  async setDisposition(reviewId, findingId, disposition) {
    return json<ReportResponse>(
      await post(
        `/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/disposition`,
        { disposition },
      ),
    );
  },
  async batch(reviewId, by, key, disposition) {
    return json<ReportResponse>(
      await post(`/api/reviews/${encodeURIComponent(reviewId)}/batch`, { by, key, disposition }),
    );
  },
  async setNonText(reviewId, messageUuid, disposition) {
    return json<ReportResponse>(
      await post(
        `/api/reviews/${encodeURIComponent(reviewId)}/nontext/${encodeURIComponent(messageUuid)}/disposition`,
        { disposition },
      ),
    );
  },
  async getGate(reviewId) {
    const data = await json<{ gate: SanitizationReport['gate'] }>(
      await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/gate`),
    );
    return data.gate;
  },
  async exportReview(reviewId) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/export`);
    if (res.status === 409) {
      const body = (await res.json()) as { gate: SanitizationReport['gate'] };
      return { ok: false, gate: body.gate };
    }
    const data = await json<ExportResponse>(res);
    return { ok: true, data };
  },
  async listProviders() {
    const data = await json<{ providers: ProviderTarget[] }>(await fetch('/api/providers'));
    return data.providers;
  },
  async listCustomProviders() {
    const data = await json<{ providers: ProviderTarget[] }>(await fetch('/api/custom-providers'));
    return data.providers;
  },
  async createCustomProvider(input) {
    const data = await json<{ provider: ProviderTarget }>(await post('/api/custom-providers', input));
    return data.provider;
  },
  async updateCustomProvider(id, fields) {
    const data = await json<{ provider: ProviderTarget }>(
      await send('PUT', `/api/custom-providers/${encodeURIComponent(id)}`, fields),
    );
    return data.provider;
  },
  async deleteCustomProvider(id) {
    await json<{ deleted: boolean }>(await send('DELETE', `/api/custom-providers/${encodeURIComponent(id)}`));
  },
  async getKeyStatus() {
    const data = await json<{ status: KeyStatusMap }>(await fetch('/api/provider-keys'));
    return data.status;
  },
  async setProviderKey(providerId, apiKey) {
    await json<{ configured: boolean }>(
      await send('PUT', `/api/provider-keys/${encodeURIComponent(providerId)}`, { apiKey }),
    );
  },
  async clearProviderKey(providerId) {
    await json<{ configured: boolean }>(
      await send('DELETE', `/api/provider-keys/${encodeURIComponent(providerId)}`),
    );
  },
  async estimateSubmit(reviewId, providerId, model, replayMode) {
    return json<SubmitEstimate>(
      await post(`/api/reviews/${encodeURIComponent(reviewId)}/submit/estimate`, {
        providerId,
        model,
        replayMode,
      }),
    );
  },
  async submit(reviewId, body) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/submit`, body);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, status: res.status, error: err.error ?? `request failed: ${res.status}` };
    }
    const data = (await res.json()) as { receipt: SubmissionReceipt };
    return { ok: true, receipt: data.receipt };
  },
  async submitCliResume(reviewId, body) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/submit`, body);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      return { ok: false, status: res.status, error: err.error ?? `request failed: ${res.status}`, code: err.code };
    }
    const data = (await res.json()) as { receipt: CliResumeReceipt };
    return { ok: true, receipt: data.receipt };
  },
  async prepareReplay(reviewId, target) {
    return json<ReplayPrepareResponse>(
      await post(`/api/reviews/${encodeURIComponent(reviewId)}/replay/prepare`, target),
    );
  },
  async setReplayFindingDisposition(reviewId, findingId, disposition) {
    return json<ReplayReportResponse>(
      await post(
        `/api/reviews/${encodeURIComponent(reviewId)}/replay/findings/${encodeURIComponent(findingId)}/disposition`,
        { disposition },
      ),
    );
  },
  async setReplayOpaqueDisposition(reviewId, itemId, disposition, replacement) {
    return json<ReplayReportResponse>(
      await post(
        `/api/reviews/${encodeURIComponent(reviewId)}/replay/opaque/${encodeURIComponent(itemId)}/disposition`,
        replacement !== undefined ? { disposition, replacement } : { disposition },
      ),
    );
  },
  async sealReplay(reviewId) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/replay/seal`);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string; gate?: SanitizationReport['gate'] };
      return { ok: false, status: res.status, error: err.error ?? `request failed: ${res.status}`, code: err.code, gate: err.gate };
    }
    const data = (await res.json()) as ReplaySealResponse;
    return { ok: true, data };
  },
  async getPreflight() {
    return json<PublishPreflight>(await fetch('/api/publish/preflight'));
  },
  async publishPlan(reviewId) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/publish/plan`);
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, plan: (await res.json()) as PublishPlan };
  },
  async publishStage(reviewId) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/publish/stage`);
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, result: (await res.json()) as PublishStageResult };
  },
  async publishSubmit(reviewId) {
    const res = await post(`/api/reviews/${encodeURIComponent(reviewId)}/publish/submit`);
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, result: (await res.json()) as PublishSubmitResult };
  },
  async publishBatchPlan(reviewIds) {
    const res = await post('/api/publish/batch/plan', { reviewIds });
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, plan: (await res.json()) as PublishBatchPlan };
  },
  async publishBatchStage(reviewIds) {
    const res = await post('/api/publish/batch/stage', { reviewIds });
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, result: (await res.json()) as PublishBatchStageResult };
  },
  async publishBatchSubmit(reviewIds) {
    const res = await post('/api/publish/batch/submit', { reviewIds });
    if (!res.ok) return { ok: false, ...((await res.json().catch(() => ({}))) as PublishError) };
    return { ok: true, result: (await res.json()) as PublishBatchSubmitResult };
  },
};

/** A category is a batch-by-type key. Guard so callers pass a valid value. */
export const NORMALIZATION_CATEGORIES: NormalizationCategory[] = [
  'path',
  'username',
  'email',
  'ipv4',
  'ipv6',
];
