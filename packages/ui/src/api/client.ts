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
  PublicationErrorBody,
  PublicationErrorCode,
  PublicationErrorPhase,
  PublicationFileSummary,
  PublicationIssue,
  PublicationPreview,
  PublicationReceipt,
  PublicationResult,
  PublicationStatus,
  PublicationSubmitInput,
  PublicationTargetSummary,
  ProjectsResponse,
  ProviderTarget,
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
  inspectPublication(): Promise<PublicationResult<PublicationStatus>>;
  configurePublicationTarget(repository: string): Promise<PublicationResult<PublicationStatus>>;
  clearPublicationTarget(): Promise<PublicationResult<PublicationStatus>>;
  previewPublication(reviewIds: string[]): Promise<PublicationResult<PublicationPreview>>;
  submitPublication(input: PublicationSubmitInput): Promise<PublicationResult<PublicationReceipt>>;
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

const PUBLICATION_ERROR_CODES = new Set<PublicationErrorCode>([
  'invalid_target',
  'target_not_configured',
  'target_not_found',
  'target_incompatible',
  'target_changed',
  'target_store_unavailable',
  'github_client_missing',
  'github_login_required',
  'github_unavailable',
  'permission_denied',
  'fork_confirmation_required',
  'fork_failed',
  'review_not_found',
  'GATE_LOCKED',
  'precheck_refused',
  'preview_not_found',
  'preview_expired',
  'preview_stale',
  'publish_in_flight',
  'workspace_unavailable',
  'workspace_corrupt',
  'branch_conflict',
  'push_rejected',
  'pr_create_failed',
]);
const PUBLICATION_ERROR_PHASES = new Set<PublicationErrorPhase>([
  'target',
  'preview',
  'workspace',
  'push',
  'pull_request',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transportError(phase: PublicationErrorPhase): PublicationErrorBody {
  return {
    code: 'transport_error',
    phase,
    message: 'The publication service could not be reached.',
    retryable: true,
    recovery: 'Check that the daemon is running, then retry.',
  };
}

/** Project only the daemon fields audited as safe for publication UI. */
function parsePublicationError(
  value: unknown,
  fallbackPhase: PublicationErrorPhase,
): PublicationErrorBody {
  if (
    !isObject(value) ||
    typeof value.code !== 'string' ||
    !PUBLICATION_ERROR_CODES.has(value.code as PublicationErrorCode) ||
    typeof value.phase !== 'string' ||
    !PUBLICATION_ERROR_PHASES.has(value.phase as PublicationErrorPhase) ||
    typeof value.message !== 'string' ||
    typeof value.retryable !== 'boolean'
  ) {
    return transportError(fallbackPhase);
  }

  const error: PublicationErrorBody = {
    code: value.code as PublicationErrorCode,
    phase: value.phase as PublicationErrorPhase,
    message: value.message,
    retryable: value.retryable,
  };
  if (typeof value.recovery === 'string') error.recovery = value.recovery;
  if (typeof value.reviewId === 'string') error.reviewId = value.reviewId;

  if (
    isObject(value.gate) &&
    typeof value.gate.blockingTotal === 'number' &&
    typeof value.gate.blockingPending === 'number' &&
    typeof value.gate.nonTextPending === 'number' &&
    typeof value.gate.unlocked === 'boolean'
  ) {
    error.gate = {
      blockingTotal: value.gate.blockingTotal,
      blockingPending: value.gate.blockingPending,
      nonTextPending: value.gate.nonTextPending,
      unlocked: value.gate.unlocked,
    };
  }

  if (Array.isArray(value.refusals)) {
    const refusals = value.refusals.flatMap((entry) => {
      if (
        !isObject(entry) ||
        typeof entry.reviewId !== 'string' ||
        typeof entry.sessionId !== 'string' ||
        !isObject(entry.blockingByRule)
      ) {
        return [];
      }
      const blockingByRule = Object.fromEntries(
        Object.entries(entry.blockingByRule).filter(
          ([ruleId, count]) =>
            ruleId.length > 0 && typeof count === 'number' && Number.isFinite(count) && count >= 0,
        ),
      ) as Record<string, number>;
      return [{ reviewId: entry.reviewId, sessionId: entry.sessionId, blockingByRule }];
    });
    error.refusals = refusals;
  }
  return error;
}

const PUBLICATION_ISSUE_CODES = new Set<PublicationIssue['code']>([
  'target_not_found',
  'target_incompatible',
  'target_store_unavailable',
  'github_client_missing',
  'github_unavailable',
  'permission_denied',
  'fork_failed',
]);
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/;
const PUBLICATION_REF = /^[A-Za-z0-9_-]{1,200}$/;

function isBoundedString(value: unknown, max = 10_000, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    !/[\u0000]/.test(value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalRepository(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length > 140 ||
    value.includes('://') ||
    value.includes('@') ||
    value.includes(':') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    return false;
  }
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    OWNER_RE.test(parts[0]) &&
    REPO_RE.test(parts[1]) &&
    parts[1] !== '.' &&
    parts[1] !== '..' &&
    !parts[1].endsWith('.git')
  );
}

function isSafeBranch(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 255 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !/[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value) &&
    value.split('/').every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !part.endsWith('.lock'),
    )
  );
}

function isRepositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1_000 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function isTargetUrl(value: unknown, slug: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/${slug}`
    );
  } catch {
    return false;
  }
}

function parsePublicationTarget(value: unknown): PublicationTargetSummary | null {
  if (
    !isObject(value) ||
    !isBoundedString(value.repositoryId, 500) ||
    !isCanonicalRepository(value.slug) ||
    !isTargetUrl(value.url, value.slug) ||
    value.visibility !== 'public' ||
    !isSafeBranch(value.defaultBranch) ||
    typeof value.baseCommitSha !== 'string' ||
    !COMMIT_SHA.test(value.baseCommitSha) ||
    !isObject(value.manifest) ||
    value.manifest.kind !== 'mosga-community-data' ||
    value.manifest.contractVersion !== 1 ||
    !Array.isArray(value.manifest.acceptedSchemaVersions) ||
    value.manifest.acceptedSchemaVersions.length < 1 ||
    value.manifest.acceptedSchemaVersions.length > 100 ||
    !value.manifest.acceptedSchemaVersions.every(
      (schema) => isBoundedString(schema, 100),
    ) ||
    new Set(value.manifest.acceptedSchemaVersions).size !==
      value.manifest.acceptedSchemaVersions.length ||
    !isBoundedString(value.manifest.license, 200) ||
    value.manifest.license.trim() !== value.manifest.license ||
    typeof value.manifest.contentHash !== 'string' ||
    !HEX_64.test(value.manifest.contentHash)
  ) {
    return null;
  }
  return {
    repositoryId: value.repositoryId,
    slug: value.slug,
    url: value.url,
    visibility: 'public',
    defaultBranch: value.defaultBranch,
    baseCommitSha: value.baseCommitSha,
    manifest: {
      kind: 'mosga-community-data',
      contractVersion: 1,
      acceptedSchemaVersions: [...value.manifest.acceptedSchemaVersions] as string[],
      license: value.manifest.license,
      contentHash: value.manifest.contentHash,
    },
  };
}

function parsePublicationIssue(value: unknown): PublicationIssue | null {
  if (
    !isObject(value) ||
    typeof value.code !== 'string' ||
    !PUBLICATION_ISSUE_CODES.has(value.code as PublicationIssue['code']) ||
    !isBoundedString(value.message) ||
    typeof value.retryable !== 'boolean' ||
    (value.recovery !== undefined && !isBoundedString(value.recovery))
  ) {
    return null;
  }
  return {
    code: value.code as PublicationIssue['code'],
    message: value.message,
    retryable: value.retryable,
    ...(typeof value.recovery === 'string' ? { recovery: value.recovery } : {}),
  };
}

function parsePublicationStatus(value: unknown): PublicationStatus | null {
  if (!isObject(value) || !isNonNegativeInteger(value.revision)) return null;
  if (value.state === 'unconfigured') {
    return { state: 'unconfigured', revision: value.revision };
  }
  if (value.state === 'blocked') {
    if (!Array.isArray(value.issues)) return null;
    const issues = value.issues.map(parsePublicationIssue);
    if (issues.some((issue) => issue === null)) return null;
    const target =
      value.target === undefined ? undefined : parsePublicationTarget(value.target);
    if (value.target !== undefined && !target) return null;
    return {
      state: 'blocked',
      revision: value.revision,
      ...(target ? { target } : {}),
      issues: issues as PublicationIssue[],
    };
  }

  const target = parsePublicationTarget(value.target);
  if (!target) return null;
  if (value.state === 'login_required') {
    return { state: 'login_required', revision: value.revision, target };
  }
  if (
    value.state === 'fork_confirmation_required' &&
    isBoundedString(value.actor, 100) &&
    isCanonicalRepository(value.pushRepository)
  ) {
    return {
      state: 'fork_confirmation_required',
      revision: value.revision,
      target,
      actor: value.actor,
      pushRepository: value.pushRepository,
    };
  }
  if (
    value.state === 'ready' &&
    isBoundedString(value.actor, 100) &&
    (value.route === 'direct' || value.route === 'fork') &&
    isCanonicalRepository(value.pushRepository) &&
    value.willCreateFork === false &&
    (value.route !== 'direct' ||
      value.pushRepository.toLowerCase() === target.slug.toLowerCase())
  ) {
    return {
      state: 'ready',
      revision: value.revision,
      target,
      actor: value.actor,
      route: value.route,
      pushRepository: value.pushRepository,
      willCreateFork: false,
    };
  }
  return null;
}

function parsePublicationFile(value: unknown): PublicationFileSummary | null {
  if (
    !isObject(value) ||
    (value.kind !== 'record' && value.kind !== 'provenance') ||
    !isRepositoryPath(value.path) ||
    !isNonNegativeInteger(value.bytes) ||
    typeof value.contentHash !== 'string' ||
    !HEX_64.test(value.contentHash)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    path: value.path,
    bytes: value.bytes,
    contentHash: value.contentHash,
  };
}

function parsePublicationPreview(value: unknown): PublicationPreview | null {
  if (
    !isObject(value) ||
    typeof value.publicationRef !== 'string' ||
    !PUBLICATION_REF.test(value.publicationRef) ||
    !isCanonicalIsoDate(value.expiresAt) ||
    !isObject(value.target) ||
    !isBoundedString(value.target.repositoryId, 500) ||
    !isNonNegativeInteger(value.target.revision) ||
    !isCanonicalRepository(value.target.upstream) ||
    !isCanonicalRepository(value.target.pushRepository) ||
    (value.target.route !== 'direct' && value.target.route !== 'fork') ||
    (value.target.forkProvision !== 'none' &&
      value.target.forkProvision !== 'existing' &&
      value.target.forkProvision !== 'on-submit') ||
    !isSafeBranch(value.target.baseBranch) ||
    typeof value.target.baseCommitSha !== 'string' ||
    !COMMIT_SHA.test(value.target.baseCommitSha) ||
    typeof value.target.willCreateFork !== 'boolean' ||
    !isObject(value.contribution) ||
    value.contribution.contractVersion !== 1 ||
    typeof value.contribution.contentDigest !== 'string' ||
    !HEX_64.test(value.contribution.contentDigest) ||
    !isSafeBranch(value.contribution.branch) ||
    !isBoundedString(value.contribution.commitMessage) ||
    !isBoundedString(value.contribution.prTitle) ||
    !isBoundedString(value.contribution.prBody, 100_000, true) ||
    !Number.isSafeInteger(value.contribution.recordCount) ||
    (value.contribution.recordCount as number) < 1 ||
    (value.contribution.recordCount as number) > 500 ||
    !isNonNegativeInteger(value.contribution.totalBytes) ||
    !Array.isArray(value.contribution.files) ||
    value.contribution.files.length < 1 ||
    !isObject(value.contribution.engine) ||
    !isBoundedString(value.contribution.engine.sanitizerPackageVersion, 200) ||
    !isBoundedString(value.contribution.engine.rulesetVersion, 1_000) ||
    !isBoundedString(value.contribution.engine.gitleaksVersion, 200)
  ) {
    return null;
  }
  const files = value.contribution.files.map(parsePublicationFile);
  if (files.some((file) => file === null)) return null;
  const target = value.target as unknown as PublicationPreview['target'];
  const contribution =
    value.contribution as unknown as PublicationPreview['contribution'];
  const direct = target.route === 'direct';
  if (
    (direct &&
      (target.forkProvision !== 'none' ||
        target.willCreateFork ||
        target.pushRepository.toLowerCase() !== target.upstream.toLowerCase())) ||
    (!direct &&
      !['existing', 'on-submit'].includes(String(target.forkProvision))) ||
    (target.forkProvision === 'on-submit') !== target.willCreateFork
  ) {
    return null;
  }
  return {
    publicationRef: value.publicationRef,
    expiresAt: value.expiresAt,
    target: {
      repositoryId: target.repositoryId,
      revision: target.revision,
      upstream: target.upstream,
      pushRepository: target.pushRepository,
      route: target.route,
      forkProvision: target.forkProvision as 'none' | 'existing' | 'on-submit',
      baseBranch: target.baseBranch,
      baseCommitSha: target.baseCommitSha,
      willCreateFork: target.willCreateFork,
    },
    contribution: {
      contractVersion: 1,
      contentDigest: contribution.contentDigest,
      branch: contribution.branch,
      commitMessage: contribution.commitMessage,
      prTitle: contribution.prTitle,
      prBody: contribution.prBody,
      recordCount: contribution.recordCount,
      totalBytes: contribution.totalBytes,
      files: files as PublicationFileSummary[],
      engine: {
        sanitizerPackageVersion: contribution.engine.sanitizerPackageVersion,
        rulesetVersion: contribution.engine.rulesetVersion,
        gitleaksVersion: contribution.engine.gitleaksVersion,
      },
    },
  };
}

function isGitHubPullRequestUrl(value: unknown, upstream: string, prNumber: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/${upstream}/pull/${String(prNumber)}`
    );
  } catch {
    return false;
  }
}

function parsePublicationReceipt(value: unknown): PublicationReceipt | null {
  if (
    !isObject(value) ||
    typeof value.publicationRef !== 'string' ||
    !PUBLICATION_REF.test(value.publicationRef) ||
    !isNonNegativeInteger(value.targetRevision) ||
    !isCanonicalRepository(value.upstream) ||
    !isCanonicalRepository(value.pushRepository) ||
    (value.mode !== 'direct' && value.mode !== 'fork') ||
    (value.mode === 'direct' &&
      value.pushRepository.toLowerCase() !== value.upstream.toLowerCase()) ||
    !isSafeBranch(value.baseBranch) ||
    typeof value.baseCommitSha !== 'string' ||
    !COMMIT_SHA.test(value.baseCommitSha) ||
    !isSafeBranch(value.branch) ||
    typeof value.commitSha !== 'string' ||
    !COMMIT_SHA.test(value.commitSha) ||
    !Number.isSafeInteger(value.prNumber) ||
    (value.prNumber as number) < 1 ||
    !isGitHubPullRequestUrl(value.prUrl, value.upstream, value.prNumber as number) ||
    !Number.isSafeInteger(value.recordCount) ||
    (value.recordCount as number) < 1 ||
    (value.recordCount as number) > 500 ||
    typeof value.contentDigest !== 'string' ||
    !HEX_64.test(value.contentDigest) ||
    !isCanonicalIsoDate(value.submittedAt)
  ) {
    return null;
  }
  return {
    publicationRef: value.publicationRef,
    targetRevision: value.targetRevision,
    upstream: value.upstream,
    pushRepository: value.pushRepository,
    mode: value.mode,
    baseBranch: value.baseBranch,
    baseCommitSha: value.baseCommitSha,
    branch: value.branch,
    commitSha: value.commitSha,
    prNumber: value.prNumber as number,
    prUrl: value.prUrl,
    recordCount: value.recordCount as number,
    contentDigest: value.contentDigest,
    submittedAt: value.submittedAt,
  };
}

async function publicationRequest<T>(
  url: string,
  phase: PublicationErrorPhase,
  project: (value: unknown) => T | null,
  init?: RequestInit,
): Promise<PublicationResult<T>> {
  try {
    const response = await fetch(url, init);
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) return { ok: false, error: parsePublicationError(payload, phase) };
    const data = project(payload);
    return data
      ? { ok: true, data }
      : { ok: false, error: transportError(phase) };
  } catch {
    return { ok: false, error: transportError(phase) };
  }
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
  async inspectPublication() {
    return publicationRequest('/api/publish', 'target', parsePublicationStatus);
  },
  async configurePublicationTarget(repository) {
    return publicationRequest('/api/publish/target', 'target', parsePublicationStatus, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository }),
    });
  },
  async clearPublicationTarget() {
    return publicationRequest('/api/publish/target', 'target', parsePublicationStatus, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
  },
  async previewPublication(reviewIds) {
    return publicationRequest('/api/publish/preview', 'preview', parsePublicationPreview, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewIds }),
    });
  },
  async submitPublication(input) {
    return publicationRequest(
      '/api/publish/submit',
      'pull_request',
      parsePublicationReceipt,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publicationRef: input.publicationRef,
          targetRevision: input.targetRevision,
          contentDigest: input.contentDigest,
          confirmPublic: true,
        }),
      },
    );
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
