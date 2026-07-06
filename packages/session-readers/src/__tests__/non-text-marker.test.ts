import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseClaudeSession } from '../parseClaudeSession.js';
import type { ContentBlock, JsonlEntry } from '../types.js';

// A non-text (image) block carries fields (`source`) outside `ContentBlock`'s
// modelled surface — exactly the shape the reused parser drops silently and the
// marker layer must catch. Cast past the excess-property check.
const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
} as unknown as ContentBlock;

let dir: string;

function writeSession(name: string, entries: JsonlEntry[]): string {
  const file = path.join(dir, name);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mosga-marker-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('non-text nested inside a tool_result', () => {
  it('marks the tool_use message the result merges into (resolved by tool_use_id)', () => {
    const file = writeSession('nested.jsonl', [
      {
        uuid: 'm1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me take a screenshot' },
            { type: 'tool_use', id: 't1', name: 'Screenshot', input: {} },
          ],
        },
      },
      {
        uuid: 'r1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [imageBlock, { type: 'text', text: 'here is the screenshot' }],
            } as unknown as ContentBlock,
          ],
        },
      },
    ]);

    const messages = parseClaudeSession(file);
    // The reused parser merges the result into the tool_use message; the raw
    // tool_result row does NOT become its own message.
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg.sdkUuid).toBe('m1');
    // Verbatim parse fidelity preserved: the text portion still merges through.
    expect(msg.toolCalls?.[0].id).toBe('t1');
    expect(msg.toolCalls?.[0].result).toBe('here is the screenshot');
    // Blocker fix: the nested image is flagged on the tool_use message.
    expect(msg.nonTextContent?.blockTypes).toContain('image');
  });
});

describe('non-text on a non-materializing row', () => {
  it('surfaces the marker on the nearest emitted message', () => {
    const file = writeSession('orphan.jsonl', [
      {
        uuid: 'u1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'a real user turn' },
      },
      {
        // isMeta rows are skipped by the reused parser → never materialize.
        uuid: 'meta1',
        isMeta: true,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [imageBlock] },
      },
      {
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
    ]);

    const messages = parseClaudeSession(file);
    const byUuid = new Map(messages.map((m) => [m.sdkUuid, m]));

    // The isMeta row produced no message of its own...
    expect(byUuid.has('meta1')).toBe(false);
    // ...but its image is not lost: it surfaces on the nearest emitted message
    // (the preceding user turn), so the ⚠ human-review path still sees it.
    expect(byUuid.get('u1')?.nonTextContent?.blockTypes).toContain('image');
    // A pure-text assistant turn stays unflagged.
    expect(byUuid.get('a1')?.nonTextContent).toBeUndefined();
  });
});
