/**
 * API-surface types. The report/finding model comes straight from
 * `@mosga/sanitizer` via `import type` (erased at runtime — zero pull-in), so the
 * UI never redefines the sanitizer's contract, and the envelope from
 * `@mosga/contracts`.
 */
import type { SanitizedSession } from '@mosga/contracts';
import type {
  Disposition,
  Finding,
  NonTextItem,
  NormalizationCategory,
  SanitizationReport,
} from '@mosga/sanitizer';

export type {
  Disposition,
  Finding,
  NonTextItem,
  NormalizationCategory,
  SanitizationReport,
  SanitizedSession,
};

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

export interface ReportResponse {
  report: SanitizationReport;
  gate: SanitizationReport['gate'];
}

export interface ExportResponse {
  session: SanitizedSession;
  gate: SanitizationReport['gate'];
}
