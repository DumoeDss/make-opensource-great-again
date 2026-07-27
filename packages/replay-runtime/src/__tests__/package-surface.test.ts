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
    expect(rootManifest.scripts.build).toContain(
      '@mosga/replay-bundle && npm run build -w @mosga/replay-runtime && npm run build -w @mosga/ui',
    );
    expect(rootManifest.scripts.typecheck).toContain(
      '@mosga/replay-bundle && npm run typecheck -w @mosga/replay-runtime && npm run typecheck -w @mosga/ui',
    );
    expect(
      readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8'),
    ).toContain(
      'contracts → readers → sanitizer → replay-bundle → replay-runtime → ui',
    );
  });
});
