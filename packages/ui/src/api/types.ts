/**
 * Browser API-surface types. Server-only implementation types are mirrored at
 * the HTTP boundary instead of being imported into the Vite graph.
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

export interface HealthResponse {
  name: string;
  version: string;
}

export interface ProviderTarget {
  id: string;
  name: string;
  apiFormat: string;
  apiBaseUrl: string;
  models: string[];
}

export type ApiFormat = 'openai' | 'openai-response' | 'anthropic' | 'gemini';
export const API_FORMATS: ApiFormat[] = ['openai', 'openai-response', 'anthropic', 'gemini'];

export interface CustomProviderInput {
  id: string;
  name: string;
  apiFormat: ApiFormat;
  apiBaseUrl: string;
  models: string[];
}

export type KeyStatusMap = Record<string, { configured: boolean }>;

export interface SubmitEstimate {
  replayMode: ReplayMode;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCostUsd: number;
  pricingSource?: 'provider' | 'default';
  contentHash: string;
}

export type NonTextDisposition = NonTextItem['disposition'];

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

// ---- 出口① GitHub publication ---------------------------------------------

export interface PublicationTargetSummary {
  repositoryId: string;
  slug: string;
  /** Public contract field. Intentionally never rendered by publication UI. */
  url: string;
  visibility: 'public';
  defaultBranch: string;
  baseCommitSha: string;
  manifest: {
    kind: 'mosga-community-data';
    contractVersion: 1;
    acceptedSchemaVersions: string[];
    license: string;
    contentHash: string;
  };
}

export type PublicationIssueCode =
  | 'target_not_found'
  | 'target_incompatible'
  | 'target_store_unavailable'
  | 'github_client_missing'
  | 'github_unavailable'
  | 'permission_denied'
  | 'fork_failed';

export interface PublicationIssue {
  code: PublicationIssueCode;
  message: string;
  recovery?: string;
  retryable: boolean;
}

/** Server-owned readiness; loading and transport failure live outside this union. */
export type PublicationStatus =
  | { state: 'unconfigured'; revision: number }
  | {
      state: 'login_required';
      revision: number;
      target: PublicationTargetSummary;
    }
  | {
      state: 'fork_confirmation_required';
      revision: number;
      target: PublicationTargetSummary;
      actor: string;
      pushRepository: string;
    }
  | {
      state: 'ready';
      revision: number;
      target: PublicationTargetSummary;
      actor: string;
      route: 'direct' | 'fork';
      pushRepository: string;
      willCreateFork: false;
    }
  | {
      state: 'blocked';
      revision: number;
      target?: PublicationTargetSummary;
      issues: PublicationIssue[];
    };

export interface PublicationFileSummary {
  kind: 'record' | 'provenance';
  path: string;
  bytes: number;
  contentHash: string;
}

export interface PublicationEngine {
  sanitizerPackageVersion: string;
  rulesetVersion: string;
  gitleaksVersion: string;
}

export interface PublicationPreview {
  publicationRef: string;
  expiresAt: string;
  target: {
    repositoryId: string;
    revision: number;
    upstream: string;
    pushRepository: string;
    route: 'direct' | 'fork';
    forkProvision: 'none' | 'existing' | 'on-submit';
    baseBranch: string;
    baseCommitSha: string;
    willCreateFork: boolean;
  };
  contribution: {
    contractVersion: 1;
    contentDigest: string;
    branch: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    recordCount: number;
    totalBytes: number;
    files: PublicationFileSummary[];
    engine: PublicationEngine;
  };
}

export interface PublicationReceipt {
  publicationRef: string;
  targetRevision: number;
  upstream: string;
  pushRepository: string;
  mode: 'direct' | 'fork';
  baseBranch: string;
  baseCommitSha: string;
  branch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  recordCount: number;
  contentDigest: string;
  submittedAt: string;
}

export type PublicationErrorCode =
  | 'invalid_target'
  | 'target_not_configured'
  | 'target_not_found'
  | 'target_incompatible'
  | 'target_changed'
  | 'target_store_unavailable'
  | 'github_client_missing'
  | 'github_login_required'
  | 'github_unavailable'
  | 'permission_denied'
  | 'fork_confirmation_required'
  | 'fork_failed'
  | 'review_not_found'
  | 'GATE_LOCKED'
  | 'precheck_refused'
  | 'preview_not_found'
  | 'preview_expired'
  | 'preview_stale'
  | 'publish_in_flight'
  | 'workspace_unavailable'
  | 'workspace_corrupt'
  | 'branch_conflict'
  | 'push_rejected'
  | 'pr_create_failed';

export type PublicationErrorPhase =
  | 'target'
  | 'preview'
  | 'workspace'
  | 'push'
  | 'pull_request';

export interface PublicationGateSummary {
  blockingTotal: number;
  blockingPending: number;
  nonTextPending: number;
  unlocked: boolean;
}

export interface PublicationRefusal {
  reviewId: string;
  sessionId: string;
  blockingByRule: Record<string, number>;
}

export interface PublicationErrorBody {
  code: PublicationErrorCode | 'transport_error';
  phase: PublicationErrorPhase;
  message: string;
  retryable: boolean;
  recovery?: string;
  reviewId?: string;
  gate?: PublicationGateSummary;
  refusals?: PublicationRefusal[];
}

export type PublicationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicationErrorBody };

export interface PublicationSubmitInput {
  publicationRef: string;
  targetRevision: number;
  contentDigest: string;
  confirmPublic: true;
}
