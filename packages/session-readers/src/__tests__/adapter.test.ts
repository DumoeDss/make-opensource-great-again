import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeCodeAdapter, extractClaudeTitle } from '../adapter/claudeCodeAdapter.js';
import { getAdapter, listAdapters } from '../adapter/registry.js';
import { parseClaudeSession } from '../parseClaudeSession.js';
import type { ContentBlock, JsonlEntry } from '../types.js';

/** Serialize entries as JSONL (one fake object per line). */
function toJsonl(entries: JsonlEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// A non-text (image) block carries fields (`source`) outside `ContentBlock`'s
// modelled surface — exactly the shape the reused parser drops silently and the
// marker layer must catch. Cast past the excess-property check.
const imageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
} as unknown as ContentBlock;

const PROJECT_A_SLUG = '-home-fake-projA';
const PROJECT_B_SLUG = '-home-fake-empty';

let root: string; // stands in for `~/.claude/projects`
let sessionAPath: string;

const sessionAEntries: JsonlEntry[] = [
  { summary: 'Fake session summary title' },
  {
    uuid: 'u1',
    cwd: '/home/fake/projA',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'the first fake user turn' },
  },
  {
    uuid: 'a1',
    cwd: '/home/fake/projA',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'a pure-text reply' }] },
  },
  {
    uuid: 'img1',
    cwd: '/home/fake/projA',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'user',
      content: [imageBlock, { type: 'text', text: 'look at this screenshot' }],
    },
  },
];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mosga-projects-'));
  // Project A: has a session.
  const dirA = path.join(root, PROJECT_A_SLUG);
  mkdirSync(dirA, { recursive: true });
  sessionAPath = path.join(dirA, 'session-a.jsonl');
  writeFileSync(sessionAPath, toJsonl(sessionAEntries), 'utf-8');
  // Project B: empty but for a sessions-index.json (no .jsonl).
  const dirB = path.join(root, PROJECT_B_SLUG);
  mkdirSync(dirB, { recursive: true });
  writeFileSync(path.join(dirB, 'sessions-index.json'), '{}', 'utf-8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('claudeCodeAdapter enumeration', () => {
  it('returns the populated project and omits the session-less one', () => {
    const projects = claudeCodeAdapter.listProjects([root]);
    expect(projects).toHaveLength(1);
    const [projA] = projects;
    expect(projA.key).toBe(PROJECT_A_SLUG);
    expect(projA.cwd).toBe('/home/fake/projA');
    expect(projA.label).toBe('projA');
  });

  it('lists sessions with title, mtime, and size', () => {
    const [projA] = claudeCodeAdapter.listProjects([root]);
    const sessions = claudeCodeAdapter.listSessions([root], projA);
    expect(sessions).toHaveLength(1);
    const [sess] = sessions;
    expect(sess.id).toBe('session-a');
    expect(sess.path).toBe(sessionAPath);
    expect(sess.title).toBe('Fake session summary title');
    expect(sess.sizeBytes).toBeGreaterThan(0);
    expect(sess.updatedAt).toBeGreaterThan(0);
  });

  it('returns an empty list (no throw) when the projects root is missing', () => {
    const missing = path.join(root, 'does-not-exist');
    expect(() => claudeCodeAdapter.listProjects([missing])).not.toThrow();
    expect(claudeCodeAdapter.listProjects([missing])).toEqual([]);
  });
});

describe('extractClaudeTitle fallback chain', () => {
  it('uses the summary when present', () => {
    expect(extractClaudeTitle([{ summary: 'A summary' }, { message: { role: 'user', content: 'x' } }])).toBe(
      'A summary',
    );
  });

  it('falls back to the first real user turn when no summary', () => {
    expect(
      extractClaudeTitle([
        { isMeta: true, message: { role: 'user', content: 'meta noise' } },
        { message: { role: 'user', content: 'the real first turn' } },
      ]),
    ).toBe('the real first turn');
  });

  it('is null when neither a summary nor a user turn exists', () => {
    expect(extractClaudeTitle([{ message: { role: 'assistant', content: 'only assistant' } }])).toBeNull();
  });
});

describe('non-text content marker', () => {
  it('flags a message that carries an image block and leaves pure-text messages unflagged', () => {
    const messages = parseClaudeSession(sessionAPath);
    const byUuid = new Map(messages.map((m) => [m.sdkUuid, m]));

    const imageMsg = byUuid.get('img1');
    expect(imageMsg?.nonTextContent?.blockTypes).toContain('image');

    const textReply = byUuid.get('a1');
    expect(textReply?.nonTextContent).toBeUndefined();

    const userTurn = byUuid.get('u1');
    expect(userTurn?.nonTextContent).toBeUndefined();
  });

  it('returns [] for a missing transcript file', () => {
    expect(parseClaudeSession(path.join(root, 'nope.jsonl'))).toEqual([]);
  });
});

describe('registry', () => {
  it('returns the Claude Code adapter by id and includes it in listAdapters()', () => {
    expect(getAdapter('claude-code')).toBe(claudeCodeAdapter);
    expect(listAdapters()).toContain(claudeCodeAdapter);
  });
});
