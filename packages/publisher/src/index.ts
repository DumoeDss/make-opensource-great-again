// @mosga/publisher — closes the v0.1 loop: export a stamped SanitizedSession to
// the on-disk JSONL dataset format, run the MANDATORY local pre-check (re-scan
// the exact bytes with the shared @mosga/sanitizer ruleset, hard-refuse on any
// blocking finding), and prepare a GitHub PR contribution.

export {
  ExportError,
  type ExportOptions,
  type ExportedRecord,
  exportSession,
  deterministicRecordPath,
  deterministicProvenancePath,
  slugifyPathComponent,
  publishedProjectKey,
  REDACTED_PROJECT_KEY,
} from './export.js';

export {
  PublishRefusedError,
  type PrecheckOptions,
  type PrecheckResult,
  precheckRecord,
  assertPrecheckClean,
  parsePublishRecord,
  scanRawBytesBackstop,
} from './precheck.js';

export { type ParityResult, checkEngineParity } from './parity.js';

export {
  type ProvenanceStamp,
  ProvenanceStampSchema,
  type EngineInfo,
} from './provenance.js';

export {
  type ContributionOptions,
  type ContributionPlan,
  type StageResult,
  type RunPrResult,
  PR_BODY_FILE,
  planContribution,
  stageContribution,
  submitContribution,
} from './pr.js';

export { loadTrustedCustomRules } from './config.js';

export {
  type CommandRunner,
  type RunResult,
  defaultRunner,
  isGitAvailable,
  isGhAvailable,
} from './runner.js';

export { gitleaksVersion, resolveSanitizerPackageVersion } from './version.js';
