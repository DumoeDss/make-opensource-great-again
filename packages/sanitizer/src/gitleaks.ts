import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Pinned gitleaks release the vendored `vendor/gitleaks.toml` was taken from.
 * MUST match the header in that file. Bump BOTH on re-vendor (design D2).
 */
export const GITLEAKS_VERSION = 'v8.18.4';

/**
 * Version of mosga's own L3 normalization + allowlist augmentation layer. Part
 * of the composite `rulesetVersion` so a change to our detectors/allowlist bumps
 * the version even when the gitleaks pin is unchanged.
 */
export const MOSGA_L3_VERSION = '0.1.0';

/**
 * Well-known documentation example secrets that gitleaks' default config does
 * NOT allowlist but which are provably non-secret (they appear verbatim in
 * vendor docs). Merged into the global allowlist stopwords during ingestion so
 * the scan does not flood reviewers with textbook examples. Documented here, not
 * silently embedded — this augmentation is versioned by MOSGA_L3_VERSION.
 */
export const MOSGA_ALLOWLIST_STOPWORDS: readonly string[] = [
  'AKIAIOSFODNN7EXAMPLE', // AWS docs example access key id
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // AWS docs example secret access key
];

/** Read the vendored gitleaks TOML text (offline; never fetched at runtime). */
export function loadVendoredGitleaksToml(): string {
  const tomlPath = fileURLToPath(new URL('../vendor/gitleaks.toml', import.meta.url));
  return readFileSync(tomlPath, 'utf-8');
}
