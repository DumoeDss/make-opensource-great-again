/**
 * Hand-crafted fake-data helpers for daemon tests. NEVER real session data or
 * real keys: every secret here is an obviously-fake, non-functional canary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type RunningDaemon, startDaemon, type DaemonOptions } from '../server.js';

// Obviously-fake canary secrets (structurally valid for their rule, but junk).
export const FAKE_AWS_KEY = 'AKIAFAKEFAKEFAKE1234'; // AKIA + 16 [A-Z0-9]
export const FAKE_GITHUB_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'; // ghp_ + 36

/** Make an isolated temp dir; caller cleans up. */
export function makeTempDir(prefix = 'mosga-daemon-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a fake `~/.claude/projects/<slug>/<id>.jsonl` session under `home`.
 * Each entry is stamped with `cwd` so the reader groups the project there.
 */
export function writeSession(
  home: string,
  slug: string,
  id: string,
  cwd: string,
  entries: Array<Record<string, unknown>>,
): void {
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ cwd, ...e }));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n'), 'utf-8');
}

/** Write a minimal `.git/config` with a single origin remote at `dir`. */
export function writeGitRemote(dir: string, remoteUrl: string): void {
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    'utf-8',
  );
}

/** A user turn containing planted fake secrets. */
export function secretTurn(uuid: string): Record<string, unknown> {
  return {
    uuid,
    parentUuid: null,
    timestamp: '2026-07-07T00:00:00.000Z',
    message: {
      role: 'user',
      // The home path yields an L3 `username` ('alice') so the pseudonym mapper
      // fills `meta.contributorAlias` with a stable placeholder — used to prove
      // the SAME mapper instance is reused at export.
      content: `deploy from /home/alice/project with key ${FAKE_AWS_KEY} and token ${FAKE_GITHUB_PAT} then continue`,
    },
  };
}

/** A user turn carrying a non-text (image) block alongside text. */
export function imageTurn(uuid: string, parentUuid: string): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    timestamp: '2026-07-07T00:00:01.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'here is a screenshot for review' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
      ],
    },
  };
}

/** A benign user turn with no secrets and no non-text content. */
export function plainTurn(uuid: string, text = 'just a normal message'): Record<string, unknown> {
  return {
    uuid,
    parentUuid: null,
    timestamp: '2026-07-07T00:00:00.000Z',
    message: { role: 'user', content: text },
  };
}

/** Start a loopback daemon for the duration of `fn`, then close it. */
export async function withServer(
  options: DaemonOptions,
  fn: (base: string, daemon: RunningDaemon) => Promise<void>,
): Promise<void> {
  const daemon = await startDaemon({ port: 0, ...options });
  try {
    await fn(daemon.url, daemon);
  } finally {
    await daemon.close();
  }
}
