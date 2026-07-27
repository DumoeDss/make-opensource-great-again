import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as replayRuntime from '../index.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const repositoryRoot = path.resolve(packageRoot, '../..');

describe('@mosga/replay-runtime package boundary', () => {
  it('exports one high-level runtime factory and type-only contracts', () => {
    expect(Object.keys(replayRuntime)).toEqual(['createReplayRuntime']);
    expect(replayRuntime.createReplayRuntime).toBeTypeOf('function');
  });

  it('depends only on the contracts and canonical bundle boundary', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@mosga/contracts',
      '@mosga/replay-bundle',
    ]);

    const source = readFileSync(
      path.join(packageRoot, 'src', 'index.ts'),
      'utf8',
    );
    for (const forbidden of [
      'sanitize',
      'captureNativeSession',
      'materialize',
      'spawn',
      'proxy',
      'direct-submit',
      'provider',
      'prompt',
      'stdout',
      'stderr',
    ]) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('is ordered immediately after replay-bundle in root commands and docs', () => {
    const rootManifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: { build: string; typecheck: string } };
    // Assert the replay-runtime/proxy block sits contiguously right after
    // replay-bundle (the runtime child's ordering concern). The span does NOT
    // extend to `ui` — packages inserted after replay-proxy (e.g. replay-submit)
    // must not break this assertion; root-build-order.test.ts guards the full
    // chain end-to-end.
    expect(rootManifest.scripts.build).toContain(
      '@mosga/replay-bundle && npm run build -w @mosga/replay-runtime && npm run build -w @mosga/replay-proxy',
    );
    expect(rootManifest.scripts.typecheck).toContain(
      '@mosga/replay-bundle && npm run typecheck -w @mosga/replay-runtime && npm run typecheck -w @mosga/replay-proxy',
    );
    expect(
      readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8'),
    ).toContain(
      'replay-bundle → replay-runtime → replay-proxy',
    );
  });
});
