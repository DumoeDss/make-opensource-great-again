import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve an installed `@mosga/*` package version by reading its `package.json`.
 * Replicates the publisher's `resolveSanitizerPackageVersion` walk (its
 * `exports` map does not expose `./package.json`, so we cannot `import` it):
 * resolve the package entry, then walk ancestor directories for the matching
 * `package.json`. Covers both the built layout (dist → workspace symlink) and
 * the source/test layout. Used for the meta message's provenance stamp.
 */
export function resolvePackageVersion(pkgName: string): string {
  const starts: string[] = [];

  const metaResolve = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
  if (typeof metaResolve === 'function') {
    try {
      starts.push(fileURLToPath(metaResolve(pkgName)));
    } catch {
      // fall through to the filesystem walk
    }
  }
  starts.push(fileURLToPath(import.meta.url));

  const [scope, name] = pkgName.startsWith('@') ? pkgName.slice(1).split('/') : ['', pkgName];
  for (const start of starts) {
    const version = findVersion(start, pkgName, scope, name);
    if (version) return version;
  }
  throw new Error(
    `could not resolve the ${pkgName} package version (its package.json was not found on any ancestor path)`,
  );
}

function findVersion(
  startPath: string,
  pkgName: string,
  scope: string,
  name: string,
): string | undefined {
  let dir = dirname(startPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidates = [
      join(dir, 'package.json'),
      scope
        ? join(dir, 'node_modules', `@${scope}`, name, 'package.json')
        : join(dir, 'node_modules', name, 'package.json'),
      scope
        ? join(dir, 'packages', name, 'package.json')
        : join(dir, 'packages', name, 'package.json'),
    ];
    for (const pkgPath of candidates) {
      const version = readMatchingVersion(pkgPath, pkgName);
      if (version) return version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readMatchingVersion(pkgPath: string, pkgName: string): string | undefined {
  if (!existsSync(pkgPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
    if (parsed.name === pkgName && typeof parsed.version === 'string') return parsed.version;
  } catch {
    // an unreadable/invalid package.json is not the one we want
  }
  return undefined;
}
