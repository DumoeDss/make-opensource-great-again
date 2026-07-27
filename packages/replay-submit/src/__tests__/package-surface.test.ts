/**
 * Package-surface test: asserts the public exports are exactly the cli-resume
 * orchestration surface, and that no import path reaches @mosga/direct-submit,
 * any reconstructed-request builder, or any direct submit function.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as surface from '../index.js';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function readSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!entry.includes('__tests__')) {
        results.push(...readSourceFiles(full));
      }
    } else if (full.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('replay-submit public surface', () => {
  it('exports only the two orchestration functions (types are erased)', () => {
    const keys = Object.keys(surface).sort();
    expect(keys).toEqual(['renderTerminalManifest', 'submitCliResume']);
  });

  it('does not import @mosga/direct-submit from any source file', () => {
    const files = readSourceFiles(packageDir);
    // Check for actual import/require statements, not documentation comments
    // that mention the package by name.
    const importPattern = /(?:from\s+|require\s*\(\s*)['"]@mosga\/direct-submit['"]/;
    const violations = files.filter((f) =>
      importPattern.test(readFileSync(f, 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('does not import any reconstructed-request builder or submit function', () => {
    const files = readSourceFiles(packageDir);
    const forbidden = [
      'buildAnthropicRequest',
      'toAnthropicMessages',
      'fetchTransport',
      'scanOutboundBytesBackstop',
    ];
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const symbol of forbidden) {
        if (content.includes(symbol)) {
          violations.push(`${path.basename(file)}: ${symbol}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
