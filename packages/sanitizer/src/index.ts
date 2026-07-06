// Rule + report + artifact schemas and inferred types (design D7). Slices 3/4
// consume these types via `import type`; slice 4 CI imports the engine too.
export {
  TranslationStatusSchema,
  type TranslationStatus,
  RuleAllowlistSchema,
  type RuleAllowlist,
  NormalizedRuleSchema,
  type NormalizedRule,
  CustomRuleSchema,
  type CustomRule,
  DegradedEntrySchema,
  type DegradedEntry,
  CompiledRulesetSchema,
  type CompiledRuleset,
  LayerSchema,
  type Layer,
  DispositionSchema,
  type Disposition,
  NormalizationCategorySchema,
  type NormalizationCategory,
  FindingFieldSchema,
  type FindingField,
  FindingLocationSchema,
  type FindingLocation,
  FindingSchema,
  type Finding,
  NonTextItemSchema,
  type NonTextItem,
  SanitizationReportSchema,
  type SanitizationReport,
} from './schemas.js';

// Ruleset ingestion: vendored gitleaks pin, TOML parse, RE2→JS translate,
// degradation ladder, custom rules, compiled shared-ruleset artifact.
export { GITLEAKS_VERSION, MOSGA_L3_VERSION, loadVendoredGitleaksToml } from './gitleaks.js';
export { translateRe2ToJs, type TranslateResult } from './translate.js';
export {
  parseGitleaksToml,
  type ParsedGitleaks,
  ingestGitleaksRules,
  type IngestedRules,
  loadCustomRules,
  type LoadedCustomRules,
  type CustomRuleError,
  compileRuleset,
  type CompileOptions,
  escapeRegExp,
} from './ingest.js';

// Scan engine: structure-aware traversal, three-layer detection, pseudonym
// mapper, non-text propagation, report + gate.
export {
  scanSession,
  type ScanResult,
  type ScanOptions,
  type RulesetWarning,
  collectScanUnits,
  collectNonTextItems,
  computeGate,
  REPORT_VERSION,
} from './scan.js';
export { PseudonymMapper } from './pseudonym.js';
export { shannonEntropy } from './entropy.js';
export { redactPreview } from './redact.js';
export { canonicalJson } from './canonical.js';

// Apply engine: per-hit + batch dispositions, offset-safe application, stamped
// export-ready session.
export {
  applyDispositions,
  type ApplyResult,
  setDispositions,
  setFindingDisposition,
  batchByRule,
  batchByType,
  setNonTextDisposition,
} from './apply.js';
