import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readSessionEntries } from '../filesystem.js';
import { encodeProjectPath } from '../claudeProjectsPaths.js';
import { deduplicateEntries, parseJsonlEntriesToAgentMessages } from '../parsers/JsonlParser.js';
import type { JsonlEntry } from '../types.js';

describe('encodeProjectPath', () => {
  it('encodes a Windows cwd to its on-disk slug (no collapse, no trim)', () => {
    const input = 'C:\\Users\\Sayo\\AppData\\Roaming\\@waifuoid\\elftia\\clawia';
    expect(encodeProjectPath(input)).toBe('C--Users-Sayo-AppData-Roaming--waifuoid-elftia-clawia');
  });
});

describe('deduplicateEntries', () => {
  it('keeps the latest entry by uuid', () => {
    const entries: JsonlEntry[] = [
      { uuid: 'dup', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'old' } },
      { uuid: 'dup', timestamp: '2026-01-02T00:00:00.000Z', message: { role: 'user', content: 'new' } },
    ];
    const deduped = deduplicateEntries(entries);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].message?.content).toBe('new');
  });
});

describe('parseJsonlEntriesToAgentMessages', () => {
  it('preserves thinking and isSidechain and merges tool results into tool calls', () => {
    const entries: JsonlEntry[] = [
      {
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00.000Z',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me think about this fake task' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'fake.txt' } },
          ],
        },
      },
      {
        uuid: 'a2',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'fake file body' }],
        },
      },
    ];

    const messages = parseJsonlEntriesToAgentMessages(entries);
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg.thinking).toBe('let me think about this fake task');
    expect(msg.isSidechain).toBe(true);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls?.[0].id).toBe('tool-1');
    expect(msg.toolCalls?.[0].result).toBe('fake file body');
    expect(msg.toolCalls?.[0].status).toBe('completed');
  });
});

describe('readSessionEntries', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mosga-parse-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a malformed JSONL line instead of failing', () => {
    const file = path.join(dir, 'session.jsonl');
    const good = JSON.stringify({ uuid: 'ok', message: { role: 'user', content: 'hi' } });
    writeFileSync(file, `${good}\n{ this is not valid json\n`, 'utf-8');
    const entries = readSessionEntries(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].uuid).toBe('ok');
  });

  it('returns [] for an unreadable/missing file', () => {
    expect(readSessionEntries(path.join(dir, 'does-not-exist.jsonl'))).toEqual([]);
  });
});
