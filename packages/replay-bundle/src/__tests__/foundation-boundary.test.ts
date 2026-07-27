import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

const foundationSources = [
  'packages/contracts/src/replay.ts',
  'packages/contracts/src/replayCanonical.ts',
  'packages/session-readers/src/nativeCapture.ts',
  'packages/session-readers/src/adapter/types.ts',
  'packages/session-readers/src/adapter/claudeCodeAdapter.ts',
  'packages/session-readers/src/adapter/codexAdapter.ts',
  'packages/sanitizer/src/replayScan.ts',
  'packages/sanitizer/src/replayApply.ts',
  'packages/replay-bundle/src/canonical.ts',
  'packages/replay-bundle/src/draft.ts',
  'packages/replay-bundle/src/integrity.ts',
  'packages/replay-bundle/src/index.ts',
];

describe('ReplayBundle foundation boundary', () => {
  it('contains no CLI execution, network, source-write, credential-read, skill-body, or fallback integration', () => {
    const forbidden = [
      /from\s+['"]node:(?:child_process|http|https|net|tls)['"]/,
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/,
      /\bfetch\s*\(/,
      /\bprocess\.env\b/,
      /\bfs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync)\b/,
      /@mosga\/direct-submit/,
      /\breconstruct(?:ed|ion)?\b/i,
      /\b(?:request|submit|provider)[^\n]*fallback\b|\bfallback[^\n]*(?:request|submit|provider)\b/i,
      /\b(?:api|provider)[_-]?key\b/i,
      /\broute[_-]?token\b/i,
      /\bskill[_-]?(?:body|root)\b/i,
    ];

    for (const relativePath of foundationSources) {
      const source = fs.readFileSync(
        path.join(repositoryRoot, relativePath),
        'utf8',
      );
      for (const pattern of forbidden) {
        expect(
          pattern.test(source),
          `${relativePath} matched ${pattern}`,
        ).toBe(false);
      }
    }
  });

  it('uses only read-only filesystem calls in native capture sources', () => {
    const readerSources = foundationSources
      .filter((file) => file.startsWith('packages/session-readers/'))
      .map((relativePath) =>
        fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
      )
      .join('\n');
    const calls = Array.from(
      readerSources.matchAll(/\bfs\.([A-Za-z0-9_]+)\s*\(/g),
      (match) => match[1],
    );

    expect(new Set(calls)).toEqual(
      new Set([
        'closeSync',
        'existsSync',
        'openSync',
        'readFileSync',
        'readSync',
        'readdirSync',
        'statSync',
      ]),
    );
    expect(readerSources).toContain("fs.openSync(filePath, 'r')");
  });
});
