import { GITLEAKS_VERSION } from '@mosga/sanitizer';

/**
 * The gitleaks pin the vendored ruleset was taken from, re-exported so the
 * provenance stamp and the CI template can reference a single source of truth.
 */
export const gitleaksVersion: string = GITLEAKS_VERSION;

/**
 * Build-time engine pin. The publisher and sanitizer workspace packages are
 * released together, so this immutable value is updated with the sanitizer
 * package manifest rather than discovered from the installation filesystem.
 */
export const sanitizerPackageVersion = '0.1.0';

/** Return the build-time engine pin without probing package metadata. */
export function resolveSanitizerPackageVersion(): string {
  return sanitizerPackageVersion;
}
