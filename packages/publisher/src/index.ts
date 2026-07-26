// @mosga/publisher — exports stamped sessions, runs the mandatory exact-byte
// pre-check, and compiles deterministic, target-independent contribution
// bundles for a delivery backend.

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
  CONTRIBUTION_BUNDLE_CONTRACT_VERSION,
  CONTRIBUTION_BUNDLE_MAX_RECORDS,
  ContributionBundleRefusedError,
  type ContributionBundleOptions,
  type ContributionBundleFile,
  type ContributionBundleRecord,
  type ContributionRefusal,
  type ContributionBundle,
  type ContributionManifestEntry,
  computeContributionContentDigest,
  compileContributionBundle,
} from './contribution.js';

export { loadTrustedCustomRules } from './config.js';

export { gitleaksVersion, resolveSanitizerPackageVersion } from './version.js';
