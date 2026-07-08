import type { MetaVersions } from './reconstruct.js';
import { resolvePackageVersion } from './version.js';

/**
 * Resolve the provenance versions stamped into the meta message: this tool's own
 * package version and the installed `@mosga/sanitizer` version (the detection
 * engine identity). Read from the packages' `package.json` — never key material.
 */
export function resolveMetaVersions(): MetaVersions {
  return {
    toolVersion: resolvePackageVersion('@mosga/direct-submit'),
    sanitizerPackageVersion: resolvePackageVersion('@mosga/sanitizer'),
  };
}
