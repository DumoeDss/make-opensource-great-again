/**
 * Typed same-origin API client. The daemon serves this UI at `/ui`, so every
 * call is a relative `/api/...` URL — no host, no CORS.
 */
import type {
  CreateReviewResponse,
  Disposition,
  ExportResponse,
  NonTextDisposition,
  NormalizationCategory,
  ProjectsResponse,
  ReportResponse,
  SanitizationReport,
  SessionRef,
  SourceRef,
} from './types';

export interface ApiClient {
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

export const apiClient: ApiClient = {
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
};

/** A category is a batch-by-type key. Guard so callers pass a valid value. */
export const NORMALIZATION_CATEGORIES: NormalizationCategory[] = [
  'path',
  'username',
  'email',
  'ipv4',
  'ipv6',
];
