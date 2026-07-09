import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AsyncCommandRunner, RunResult } from '../index.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BatchPublishRefusedError,
  planBatchContributionAsync,
  planContributionAsync,
  stageBatchContributionAsync,
  submitBatchContributionAsync,
} from '../index.js';
import {
  FAKE_GITHUB_PAT,
  RULESET,
  SANITIZER_PACKAGE_VERSION,
  makeMessage,
  makeStampedSession,
} from './_fixtures.js';

/** Records every async command; canned results, no real git/gh. */
class FakeAsyncRunner implements AsyncCommandRunner {
  calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  git = true;
  gh = true;
  pushRejected = false;
  async runAsync(command: string, args: string[], opts?: { cwd?: string }): Promise<RunResult> {
    this.calls.push({ command, args, cwd: opts?.cwd });
    if (command === 'git' && args[0] === '--version') {
      return { code: this.git ? 0 : 127, stdout: 'git version 2', stderr: '' };
    }
    if (command === 'gh' && args[0] === '--version') {
      return { code: this.gh ? 0 : 127, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'push') {
      return this.pushRejected
        ? { code: 1, stdout: '', stderr: 'rejected' }
        : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

const tmpDirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mosga-batch-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Base plan options: pinned engine/time + the real compiled ruleset for realistic stamps. */
const opts = (repo: string, runner: AsyncCommandRunner) => ({
  targetRepo: repo,
  ruleset: RULESET,
  asyncRunner: runner,
  sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
  now: '2026-07-09T00:00:00.000Z',
});

function cleanWith(sessionId: string, alias?: string) {
  return makeStampedSession(
    [
      makeMessage({ role: 'user', content: 'Please refactor the parser to be more readable.' }),
      makeMessage({ role: 'assistant', content: 'Done — split into three helpers.' }),
    ],
    { sessionId, contributorAlias: alias },
  );
}

function canaryWith(sessionId: string) {
  return makeStampedSession(
    [makeMessage({ role: 'assistant', content: `deploy token: ${FAKE_GITHUB_PAT}` })],
    { sessionId },
  );
}

describe('planBatchContributionAsync', () => {
  it('is deterministic: the same set in any order maps to the same branch', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const a = cleanWith('aaa');
    const b = cleanWith('bbb');
    const p1 = await planBatchContributionAsync([a, b], opts(repo, runner));
    const p2 = await planBatchContributionAsync([b, a], opts(repo, runner));
    expect(p1.branch).toBe(p2.branch);
    expect(p1.branch).toMatch(/^contrib\/USERNAME_1\/batch-[0-9a-f]{8}$/);
    expect(p1.recordCount).toBe(2);
  });

  it('degrades a batch of one to the single-session plan byte-for-byte', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const session = cleanWith('solo');
    const batch = await planBatchContributionAsync([session], opts(repo, runner));
    const single = await planContributionAsync(session, opts(repo, runner));

    expect(batch.branch).toBe(single.branch);
    expect(batch.prTitle).toBe(single.prTitle);
    expect(batch.prBody).toBe(single.prBody);
    expect(batch.commitMessage).toBe(single.commitMessage);
    expect(batch.commands).toEqual(single.commands);
    expect(batch.stagedFiles).toEqual(single.stagedFiles);
    expect(batch.records).toEqual([single.record]);
    expect(batch.recordCount).toBe(1);
  });

  it('refuses an alias mismatch as a config error naming the conflict', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const a = cleanWith('a', '<USERNAME_1>');
    const b = cleanWith('b', '<USERNAME_2>');
    await expect(planBatchContributionAsync([a, b], opts(repo, runner))).rejects.toThrow(
      /contributorAlias/,
    );
  });

  it('refuses a duplicate sessionId', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const a = cleanWith('dup');
    const b = cleanWith('dup');
    await expect(planBatchContributionAsync([a, b], opts(repo, runner))).rejects.toThrow(/duplicate/);
  });

  it('aggregates pre-check refusals across every refused session (no fail-fast)', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const leakA = canaryWith('leak-a');
    const clean = cleanWith('ok');
    const leakB = canaryWith('leak-b');
    try {
      await planBatchContributionAsync([leakA, clean, leakB], opts(repo, runner));
      throw new Error('expected a batch refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(BatchPublishRefusedError);
      const refusals = (e as BatchPublishRefusedError).refusals;
      expect(refusals.map((r) => r.sessionId).sort()).toEqual(['leak-a', 'leak-b']);
      expect(refusals.every((r) => r.blockingFindings.length > 0)).toBe(true);
    }
    // Nothing was written to the repo (a refusal plans/stages nothing).
    expect(existsSync(join(repo, 'data'))).toBe(false);
  });

  it('renders a PR body with one table row per session plus a totals line', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const a = makeStampedSession(
      [makeMessage({ content: 'x' }), makeMessage({ content: 'y' })],
      { sessionId: 'sa' },
    );
    const b = makeStampedSession([makeMessage({ content: 'z' })], { sessionId: 'sb' });
    const p = await planBatchContributionAsync([a, b], opts(repo, runner));
    expect(p.prBody).toContain('| `sa` |');
    expect(p.prBody).toContain('| `sb` |');
    expect(p.prBody).toMatch(/totals/);
    expect(p.prBody).toContain('0 surviving blocking findings');
    expect(p.commitMessage).toContain('records: 2');
    expect(p.prTitle).toBe('Add 2 sanitized sessions (<USERNAME_1>)');
  });
});

describe('stageBatchContributionAsync', () => {
  it('writes every record + sidecar and commits them under one branch', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const p = await planBatchContributionAsync([cleanWith('sa'), cleanWith('sb')], opts(repo, runner));
    const staged = await stageBatchContributionAsync(p, { targetRepo: repo, asyncRunner: runner });

    expect(staged.committed).toBe(true);
    // 2 records + 2 sidecars all placed at their deterministic paths.
    expect(p.stagedFiles).toHaveLength(4);
    for (const rel of p.stagedFiles) {
      expect(existsSync(join(repo, ...rel.split('/')))).toBe(true);
    }
    // Exactly one checkout → add → commit sequence (one commit for all records).
    const gitVerbs = runner.calls
      .filter((c) => c.command === 'git' && c.args[0] !== '--version')
      .map((c) => c.args[0]);
    expect(gitVerbs).toEqual(['checkout', 'add', 'commit']);
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'push')).toBe(false);
  });
});

describe('submitBatchContributionAsync', () => {
  it('pushes once and opens one PR when gh is authenticated', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    const p = await planBatchContributionAsync([cleanWith('sa'), cleanWith('sb')], opts(repo, runner));
    const res = await submitBatchContributionAsync(p, { targetRepo: repo, asyncRunner: runner });
    expect(res.opened).toBe(true);
    expect(runner.calls.filter((c) => c.command === 'git' && c.args[0] === 'push')).toHaveLength(1);
    expect(runner.calls.filter((c) => c.command === 'gh' && c.args[0] === 'pr')).toHaveLength(1);
  });

  it('reports a rejected push distinctly from a failed PR open', async () => {
    const repo = tempRepo();
    const runner = new FakeAsyncRunner();
    runner.pushRejected = true;
    const p = await planBatchContributionAsync([cleanWith('sa'), cleanWith('sb')], opts(repo, runner));
    const res = await submitBatchContributionAsync(p, { targetRepo: repo, asyncRunner: runner });
    expect(res.opened).toBe(false);
    expect(res.pushRejected).toBe(true);
    // A rejected push never reaches `gh pr create`.
    expect(runner.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr')).toBe(false);
  });
});
