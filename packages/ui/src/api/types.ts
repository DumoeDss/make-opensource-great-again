/**
 * API-surface types. The report/finding model comes straight from
 * `@mosga/sanitizer` via `import type` (erased at runtime — zero pull-in), so the
 * UI never redefines the sanitizer's contract, and the envelope from
 * `@mosga/contracts`.
 */
import type {
  ContributionConsent,
  ReplayMode,
  SanitizedSession,
  SubmissionReceipt,
} from '@mosga/contracts';
import type {
  Disposition,
  Finding,
  NonTextItem,
  NormalizationCategory,
  SanitizationReport,
} from '@mosga/sanitizer';

export type {
  ContributionConsent,
  Disposition,
  Finding,
  NonTextItem,
  NormalizationCategory,
  ReplayMode,
  SanitizationReport,
  SanitizedSession,
  SubmissionReceipt,
};

/** The daemon `/api/health` response (name + version, no secrets). */
export interface HealthResponse {
  name: string;
  version: string;
}

/** A selectable direct-submit provider (key-free — never carries a key). */
export interface ProviderTarget {
  id: string;
  name: string;
  apiFormat: string;
  apiBaseUrl: string;
  models: string[];
}

/** The four request formats a custom provider may use. */
export type ApiFormat = 'openai' | 'openai-response' | 'anthropic' | 'gemini';

/** The list of `apiFormat` options for the custom-provider form dropdown. */
export const API_FORMATS: ApiFormat[] = ['openai', 'openai-response', 'anthropic', 'gemini'];

/** A custom-provider create/edit payload (key-free). `id` is client-chosen on create. */
export interface CustomProviderInput {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  apiBaseUrl: string;
  models: string[];
}

/** Per-provider key status — `configured` boolean only, never any key bytes. */
export type KeyStatusMap = Record<string, { configured: boolean }>;

/** The submit cost-estimate response (mirrors the daemon shape + content hash). */
export interface SubmitEstimate {
  replayMode: ReplayMode;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCostUsd: number;
  /** Whether the cost used provider-specific pricing or the generic default. */
  pricingSource?: 'provider' | 'default';
  /** sha256 of the stamped session — binds the consent record to exact content. */
  contentHash: string;
}

export type NonTextDisposition = NonTextItem['disposition'];

/** A rule that failed to compile on this runtime (mirrors the daemon shape). */
export interface RulesetWarning {
  ruleId: string;
  reason: string;
  degradedTo: 'keyword' | 'none';
}

export interface SourceRef {
  id: string;
  displayName: string;
}

export interface ProjectAnnotation {
  sourceId: string;
  key: string;
  cwd: string | null;
  label: string;
  gitRemote: string | null;
  recommended: boolean;
  recommendReason: string;
  /** Cheap per-project session count from the daemon (absent on older payloads). */
  sessionCount?: number;
}

export interface SessionRef {
  sourceId: string;
  projectKey: string;
  id: string;
  path: string;
  title: string | null;
  cwd: string | null;
  updatedAt: number;
  sizeBytes: number;
}

export interface ProjectsResponse {
  projects: ProjectAnnotation[];
  totalCount: number;
  recommendedCount: number;
  showAll: boolean;
}

export interface CreateReviewResponse {
  reviewId: string;
  report: SanitizationReport;
  rulesetWarnings: RulesetWarning[];
}

/**
 * One entry in the review queue: the created review plus the `SessionRef` it came
 * from. The ref rides along because `CreateReviewResponse` carries no title/time —
 * the queue bar needs them to label each session. A length-1 queue is a single
 * review, behaviourally identical to the pre-queue single-session journey.
 */
export interface QueueItem {
  review: CreateReviewResponse;
  ref: SessionRef;
}

export interface ReportResponse {
  report: SanitizationReport;
  gate: SanitizationReport['gate'];
}

export interface ExportResponse {
  session: SanitizedSession;
  gate: SanitizationReport['gate'];
}

// ---- 出口① publish (plan / stage / submit + preflight) -------------------

/** The five capability flags driving the exit-① card's four states. */
export interface PublishPreflight {
  dataRepoConfigured: boolean;
  gitAvailable: boolean;
  ghAvailable: boolean;
  ghAuthenticated: boolean;
  repoClean: boolean;
}

/**
 * The UI-safe subset of the publisher's `ContributionPlan` (record bytes
 * EXCLUDED — a byte count + content hash stand in), plus the daemon-derived
 * `compareUrl` for the gh-free browser fallback.
 */
export interface PublishPlan {
  branch: string;
  targetBranch: string;
  recordPath: string;
  provenancePath: string;
  prTitle: string;
  prBody: string;
  commitMessage: string;
  recordCount: number;
  ghAvailable: boolean;
  stagedFiles: string[];
  commands: string[];
  provenance: Record<string, unknown>;
  engine: Record<string, unknown>;
  compareUrl: string | null;
  recordBytes: number;
  contentHash: string;
}

/** A typed publish error body (mirrors `/submit`: `{ error, code, ...detail }`). */
export interface PublishError {
  error: string;
  code: string;
  /** `precheck_refused` detail: rule-aggregated blocking counts (never raw values). */
  blockingByRule?: Array<{ ruleId: string; count: number }>;
  /** `branch_exists` detail: the existing deterministic branch name. */
  branch?: string;
  /**
   * Batch `precheck_refused` detail: per-session rule-aggregated counts (never raw
   * values). The UI groups the refusal by session and offers a jump back to ②.
   */
  blockingBySession?: Array<{
    reviewId: string;
    sessionId: string;
    blockingByRule: Array<{ ruleId: string; count: number }>;
  }>;
  /** Batch gate/404 attribution: the offending review (`GATE_LOCKED` / unknown). */
  reviewId?: string;
}

export interface PublishStageResult {
  staged: true;
  branch: string;
  stagedFiles: string[];
  recordPath: string;
}

export interface PublishSubmitResult {
  opened: true;
  branch: string;
  receipt: {
    branch: string;
    targetBranch: string;
    prTitle: string;
    compareUrl: string | null;
    submittedAt: string;
  };
}

// ---- 批量 出口① publish (batch plan / stage / submit) ---------------------

/** One record's UI-safe metadata in a batch plan (bytes excluded — count + hash stand in). */
export interface PublishBatchRecord {
  sessionId: string;
  recordPath: string;
  provenancePath: string;
  recordBytes: number;
  contentHash: string;
  messages: number;
}

/**
 * The UI-safe batch plan — mirrors the daemon's `uiSafeBatchPlan` exactly: N
 * records under one branch/commit/PR, per-record metadata + totals, record bytes
 * EXCLUDED. `provenance` is per-record (in the sidecars), so unlike the single plan
 * there is no top-level provenance field.
 */
export interface PublishBatchPlan {
  branch: string;
  targetBranch: string;
  prTitle: string;
  prBody: string;
  commitMessage: string;
  recordCount: number;
  ghAvailable: boolean;
  stagedFiles: string[];
  commands: string[];
  engine: Record<string, unknown>;
  compareUrl: string | null;
  totalRecordBytes: number;
  records: PublishBatchRecord[];
}

export interface PublishBatchStageResult {
  staged: true;
  branch: string;
  stagedFiles: string[];
  recordCount: number;
}

export interface PublishBatchSubmitResult {
  opened: true;
  branch: string;
  receipt: {
    branch: string;
    targetBranch: string;
    prTitle: string;
    compareUrl: string | null;
    submittedAt: string;
    recordCount: number;
  };
}
