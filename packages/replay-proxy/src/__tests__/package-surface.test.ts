import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as replayProxy from '../index.js';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('@mosga/replay-proxy package boundary', () => {
  it('exports one high-level factory plus the max-bytes default as values only', () => {
    expect(Object.keys(replayProxy).sort()).toEqual([
      'DEFAULT_MAX_REQUEST_BYTES',
      'createReplayProxy',
    ]);
    expect(replayProxy.createReplayProxy).toBeTypeOf('function');
    expect(replayProxy.DEFAULT_MAX_REQUEST_BYTES).toBeTypeOf('number');
  });

  it('declares only the type-only workspace dependencies the design permits', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@mosga/contracts',
      '@mosga/replay-runtime',
    ]);
  });

  it('source-scans every src file and rejects forbidden imports', () => {
    const forbidden = [
      '@mosga/direct-submit',
      '@mosga/sanitizer',
      '@mosga/replay-bundle',
      '@mosga/daemon',
      '@mosga/ui',
      '@mosga/session-readers',
      '@mosga/publisher',
    ];
    const files = collectSourceFiles(path.join(packageRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbiddenImport of forbidden) {
        expect(
          source,
          `${file} must not import ${forbiddenImport}`,
        ).not.toContain(forbiddenImport);
      }
    }
  });

  it('source-scans for credential/sanitizer/proxy-server surface keywords', () => {
    const files = collectSourceFiles(path.join(packageRoot, 'src'));
    // The proxy MUST NOT expose: a sanitizer, secret-scanner, content-rewriter,
    // reconstructed-request builder, or a general-purpose HTTP server factory.
    const forbiddenSymbols = [
      'sanitize',
      'scanSecrets',
      'rewritePrompt',
      'reconstructRequest',
      'createServer', // we use node:http internally, but never export a server factory
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const symbol of forbiddenSymbols) {
        // Allow the word in comments/strings only if not an export/import.
        expect(
          source,
          `${file} must not surface ${symbol}`,
        ).not.toContain(`export function ${symbol}`);
        expect(source).not.toContain(`export const ${symbol} `);
      }
    }
  });
});

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
