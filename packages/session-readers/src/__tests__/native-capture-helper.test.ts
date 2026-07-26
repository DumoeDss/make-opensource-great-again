import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureStrictJsonl } from '../nativeCapture.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempFile(content: string, extension = '.jsonl'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mosga-native-capture-'));
  roots.push(root);
  const file = path.join(root, `session${extension}`);
  writeFileSync(file, content, 'utf8');
  return file;
}

function capture(file: string) {
  return captureStrictJsonl({
    sourceCli: 'claude-code',
    sourceFormat: 'claude-code-jsonl',
    sessionIdAlias: 'session-1',
    transcriptPath: file,
  });
}

describe('captureStrictJsonl', () => {
  it('retains every nonblank object row, ordinal, unknown field, and reference', () => {
    const file = tempFile(
      [
        JSON.stringify({ type: 'known', uuid: 'row-1', count: 1 }),
        '',
        JSON.stringify({
          type: 'future',
          unknown: { nested: [true, null, { parentUuid: 'row-1' }] },
        }),
      ].join('\r\n'),
    );
    const before = readFileSync(file, 'utf8');
    const result = capture(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.files[0]!.rows).toEqual([
      {
        ordinal: 0,
        value: { type: 'known', uuid: 'row-1', count: 1 },
      },
      {
        ordinal: 1,
        value: {
          type: 'future',
          unknown: { nested: [true, null, { parentUuid: 'row-1' }] },
        },
      },
    ]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    ['', 'empty-session'],
    ['\n \r\n', 'empty-session'],
    ['{"ok":true}\nnot json\n', 'malformed-jsonl'],
    ['{"ok":true}\n[1,2]\n', 'non-object-row'],
    ['null\n', 'non-object-row'],
  ])('fails closed without a partial artifact: %s', (content, code) => {
    const result = capture(tempFile(content));
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(result).not.toHaveProperty('artifact');
  });

  it('returns stable missing, format, and compression failures without paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mosga-native-capture-'));
    roots.push(root);
    const missing = path.join(root, 'private-session.jsonl');
    const missingResult = capture(missing);
    expect(missingResult).toMatchObject({
      ok: false,
      error: { code: 'missing-file' },
    });

    const unsupported = capture(tempFile('{}\n', '.txt'));
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'unsupported-format' },
    });

    const compressed = capture(tempFile('fake compressed bytes', '.jsonl.zst'));
    expect(compressed).toMatchObject({
      ok: false,
      error: { code: 'unsupported-compression' },
    });

    for (const result of [missingResult, unsupported, compressed]) {
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('fake compressed bytes');
    }
  });
});
