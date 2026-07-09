/**
 * codexAdapter enumeration tests.
 *
 * Drives the adapter against a synthetic
 * `~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<uuid>.jsonl` fixture under a temp dir
 * (never the real `~/.codex`): identity, date-tree grouping by `session_meta.cwd`,
 * session refs, the `(unknown)` project for cwd-less rollouts, a skipped
 * `.jsonl.zst` sibling, and a missing tree degrading cleanly. Plus pure
 * `parseCodexSessionMeta` cases (scaffolding skipped).
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { codexAdapter, parseCodexSessionMeta } from '../adapter/codexAdapter.js';

const THREAD_ID = '0199c3a0-1234-7abc-89de-0123456789ab';
const UNKNOWN_ID = '0199dead-beef-7abc-89de-0123456789ab';
const CWD = '/Users/test/codeproj';

let tmpHome: string;
let sessionsRoot: string;
let rolloutPath: string;
let unknownRolloutPath: string;

function jsonl(lines: object[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

beforeAll(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'mosga-codex-'));
  sessionsRoot = path.join(tmpHome, '.codex', 'sessions');
  const dayDir = path.join(sessionsRoot, '2025', '09', '23');
  mkdirSync(dayDir, { recursive: true });

  // A rollout with a cwd; a scaffolding user turn precedes the real prompt.
  rolloutPath = path.join(dayDir, `rollout-2025-09-23T01-31-43-${THREAD_ID}.jsonl`);
  writeFileSync(
    rolloutPath,
    jsonl([
      { type: 'session_meta', payload: { id: THREAD_ID, cwd: CWD } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>cwd is …</environment_context>' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Real first prompt' }],
        },
      },
    ]),
    'utf-8',
  );

  // A rollout with no cwd → the synthetic `(unknown)` project.
  unknownRolloutPath = path.join(dayDir, `rollout-2025-09-23T02-00-00-${UNKNOWN_ID}.jsonl`);
  writeFileSync(
    unknownRolloutPath,
    jsonl([
      { type: 'session_meta', payload: { id: UNKNOWN_ID } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'A rollout with no working directory' }],
        },
      },
    ]),
    'utf-8',
  );

  // A compressed sibling — recognized but NOT enumerated (D2).
  writeFileSync(
    path.join(dayDir, `rollout-2025-09-23T03-00-00-${'0199aaaa-1111-7abc-89de-0123456789ab'}.jsonl.zst`),
    'not real zstd bytes',
    'utf-8',
  );
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('codexAdapter — enumeration', () => {
  it('exposes the locked source identity', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(codexAdapter.displayName).toBe('Codex');
  });

  it('locateRoots points at <home>/.codex/sessions', () => {
    expect(codexAdapter.locateRoots(tmpHome)).toEqual([sessionsRoot]);
  });

  it('listProjects groups by cwd (label = basename) with a synthetic (unknown)', () => {
    const projects = codexAdapter.listProjects([sessionsRoot]);
    const byKey = new Map(projects.map((p) => [p.key, p]));
    expect(byKey.get(CWD)).toMatchObject({ sourceId: 'codex', key: CWD, cwd: CWD, label: 'codeproj' });
    expect(byKey.get('(unknown)')).toMatchObject({
      sourceId: 'codex',
      key: '(unknown)',
      cwd: null,
      label: '(unknown)',
    });
    expect(projects).toHaveLength(2);
  });

  it('listSessions fills id/path/title/cwd/mtime/size; scaffolding title skipped', () => {
    const project = { sourceId: 'codex', key: CWD, cwd: CWD, label: 'codeproj' };
    const sessions = codexAdapter.listSessions([sessionsRoot], project);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.id).toBe(THREAD_ID);
    expect(session.path).toBe(rolloutPath);
    expect(session.title).toBe('Real first prompt');
    expect(session.cwd).toBe(CWD);
    expect(session.sizeBytes).toBe(statSync(rolloutPath).size);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it('a cwd-less rollout lists under the (unknown) project with cwd: null', () => {
    const project = { sourceId: 'codex', key: '(unknown)', cwd: null, label: '(unknown)' };
    const sessions = codexAdapter.listSessions([sessionsRoot], project);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(UNKNOWN_ID);
    expect(sessions[0]!.cwd).toBeNull();
  });

  it('does not enumerate the .jsonl.zst sibling (recognized but skipped)', () => {
    const cwdSessions = codexAdapter.listSessions(
      [sessionsRoot],
      { sourceId: 'codex', key: CWD, cwd: CWD, label: 'codeproj' },
    );
    const unknownSessions = codexAdapter.listSessions(
      [sessionsRoot],
      { sourceId: 'codex', key: '(unknown)', cwd: null, label: '(unknown)' },
    );
    const allPaths = [...cwdSessions, ...unknownSessions].map((s) => s.path);
    expect(allPaths.some((p) => p.endsWith('.zst'))).toBe(false);
  });

  it('missing codex tree degrades cleanly (no throw, empty arrays)', () => {
    const ghostRoot = path.join(tmpHome, 'no-such-dir');
    expect(codexAdapter.listProjects([ghostRoot])).toEqual([]);
    expect(
      codexAdapter.listSessions([ghostRoot], { sourceId: 'codex', key: CWD, cwd: CWD, label: 'x' }),
    ).toEqual([]);
  });

  it('resolveTranscriptPath returns the ref path', () => {
    const sessions = codexAdapter.listSessions(
      [sessionsRoot],
      { sourceId: 'codex', key: CWD, cwd: CWD, label: 'codeproj' },
    );
    expect(codexAdapter.resolveTranscriptPath(sessions[0]!)).toBe(rolloutPath);
  });
});

describe('parseCodexSessionMeta', () => {
  it('reads id + cwd and skips scaffolding for the title', () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { id: 'tid', cwd: '/p' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<user_instructions>do x</user_instructions>' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The real ask' }],
        },
      }),
    ];
    expect(parseCodexSessionMeta(lines)).toEqual({ id: 'tid', cwd: '/p', title: 'The real ask' });
  });

  it('returns null fields for an empty/garbage prefix', () => {
    expect(parseCodexSessionMeta(['', 'not json'])).toEqual({ id: null, cwd: null, title: null });
  });
});
