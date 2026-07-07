import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITLEAKS_VERSION } from '@mosga/sanitizer';

/**
 * The gitleaks pin the vendored ruleset was taken from, re-exported so the
 * provenance stamp and the CI template can reference a single source of truth.
 */
export const gitleaksVersion: string = GITLEAKS_VERSION;

/**
 * Resolve the installed `@mosga/sanitizer` package version by reading its
 * `package.json`. This pins the *engine*, not just the rule text (sanitizer
 * review m3): a `regexSource` can compile differently across engine/runtime
 * versions, so the community CI template pins `@mosga/sanitizer@<this version>`
 * to guarantee a byte-identical matching engine.
 *
 * The package's `exports` map deliberately does not expose `./package.json`, so
 * we cannot `import` it. Instead we resolve the package's module location and
 * walk up to its `package.json`, covering both the built layout
 * (`packages/publisher/dist` → workspace symlink) and the source/test layout.
 */
export function resolveSanitizerPackageVersion(): string {
  const starts: string[] = [];

  // Strategy 1: ESM resolution of the package entry (uses the `import`
  // condition; `import.meta.resolve` is synchronous on Node 20.6+).
  const metaResolve = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
  if (typeof metaResolve === 'function') {
    try {
      starts.push(fileURLToPath(metaResolve('@mosga/sanitizer')));
    } catch {
      // fall through to the filesystem walk
    }
  }

  // Strategy 2: walk up from this module's own location (covers test runners
  // where `import.meta.resolve` is unavailable or points elsewhere).
  starts.push(fileURLToPath(import.meta.url));

  for (const start of starts) {
    const version = findSanitizerVersion(start);
    if (version) return version;
  }

  throw new Error(
    'could not resolve the @mosga/sanitizer package version (its package.json was not found on any ancestor path)',
  );
}

/**
 * Walk ancestor directories of `startPath`, checking each for the sanitizer's
 * `package.json` under the layouts we might encounter: the ancestor itself, a
 * `node_modules/@mosga/sanitizer` child, or a `packages/sanitizer` sibling.
 */
function findSanitizerVersion(startPath: string): string | undefined {
  let dir = dirname(startPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidates = [
      join(dir, 'package.json'),
      join(dir, 'node_modules', '@mosga', 'sanitizer', 'package.json'),
      join(dir, 'packages', 'sanitizer', 'package.json'),
    ];
    for (const pkgPath of candidates) {
      const version = readSanitizerVersion(pkgPath);
      if (version) return version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readSanitizerVersion(pkgPath: string): string | undefined {
  if (!existsSync(pkgPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
    if (parsed.name === '@mosga/sanitizer' && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // an unreadable/invalid package.json is not the one we want
  }
  return undefined;
}
