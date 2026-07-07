import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CommandRunner,
  type RunResult,
  PublishRefusedError,
  isGitAvailable,
  planContribution,
  stageContribution,
} from '../index.js';
import {
  RULESET_VERSION,
  SANITIZER_PACKAGE_VERSION,
  canarySession,
  cleanSession,
} from './_fixtures.js';

/** Records every command; never touches real git/gh. Configurable presence. */
class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  constructor(private readonly present: { gh?: boolean; git?: boolean } = {}) {}
  run(command: string, args: string[], opts?: { cwd?: string }): RunResult {
    this.calls.push({ command, args, cwd: opts?.cwd });
    if (command === 'gh' && args[0] === '--version') {
      return { code: this.present.gh ? 0 : 127, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === '--version') {
      return { code: this.present.git === false ? 127 : 0, stdout: 'git version 2', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
}

const tmpDirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mosga-pub-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const BASE = { sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION };

describe('PR submission', () => {
  it('plans a branch, deterministic path, and staged files for a clean artifact', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: true, git: true });
    const plan = planContribution(cleanSession(), { ...BASE, targetRepo: repo, runner });

    expect(plan.branch).toBe('contrib/USERNAME_1/sess-abc123');
    expect(plan.recordPath).toBe('data/0.1.0/USERNAME_1/sess-abc123.jsonl');
    expect(plan.stagedFiles).toEqual([plan.recordPath, plan.provenancePath]);
    expect(plan.recordCount).toBe(1);
  });

  it('does NOT plan or stage anything for a failed pre-check', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: true, git: true });
    expect(() =>
      planContribution(canarySession(), { ...BASE, targetRepo: repo, runner }),
    ).toThrow(PublishRefusedError);
    // Nothing was written into the target repo.
    expect(readdirSync(repo)).toHaveLength(0);
  });

  it('renders a PR body carrying the full provenance/version stamp', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: false, git: true });
    const plan = planContribution(cleanSession(), { ...BASE, targetRepo: repo, runner });
    expect(plan.prBody).toContain(RULESET_VERSION);
    expect(plan.prBody).toContain(`@mosga/sanitizer@${SANITIZER_PACKAGE_VERSION}`);
    expect(plan.prBody).toContain(plan.provenance.gitleaksVersion);
    expect(plan.prBody).toContain('0 surviving blocking findings');
  });

  it('emits the exact git/gh commands when gh is absent', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: false, git: true });
    const plan = planContribution(cleanSession(), { ...BASE, targetRepo: repo, runner });
    expect(plan.ghAvailable).toBe(false);
    expect(plan.commands).toContain('git checkout -b contrib/USERNAME_1/sess-abc123');
    expect(plan.commands.some((c) => c.startsWith('git add data/0.1.0/USERNAME_1/sess-abc123.jsonl'))).toBe(true);
    expect(plan.commands.some((c) => c.startsWith('gh pr create'))).toBe(true);
    expect(plan.commands.some((c) => c.startsWith('git push'))).toBe(true);
  });

  it('detects gh when present', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: true, git: true });
    const plan = planContribution(cleanSession(), { ...BASE, targetRepo: repo, runner });
    expect(plan.ghAvailable).toBe(true);
  });

  it('stages the record file + branch + commit via the runner (no push, no PR)', () => {
    const repo = tempRepo();
    const runner = new FakeRunner({ gh: false, git: true });
    const session = cleanSession();
    const plan = planContribution(session, { ...BASE, targetRepo: repo, runner });
    const staged = stageContribution(plan, { ...BASE, targetRepo: repo, runner });

    expect(staged.committed).toBe(true);
    // The record file was actually placed at its deterministic path.
    const recordAbs = join(repo, ...plan.recordPath.split('/'));
    expect(existsSync(recordAbs)).toBe(true);
    const roundTrip = JSON.parse(readFileSync(recordAbs, 'utf-8').trim()) as unknown;
    // The written bytes equal the PUBLISHED record (projectKey normalized), and
    // the message body stays isomorphic to the input.
    expect(roundTrip).toEqual(plan.record.session);
    expect(plan.record.session.messages).toEqual(session.messages);

    // The git steps were branch → add → commit, and NO push / gh pr create ran.
    const gitVerbs = runner.calls
      .filter((c) => c.command === 'git' && c.args[0] !== '--version')
      .map((c) => c.args[0]);
    expect(gitVerbs).toEqual(['checkout', 'add', 'commit']);
    expect(runner.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr')).toBe(false);
    expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'push')).toBe(false);
  });

  it('stages a real commit against a local dry-run git repo (no external PR)', () => {
    if (!isGitAvailable()) return; // skip where git is unavailable
    const repo = tempRepo();
    // A local, throwaway repo — never a live external remote.
    expect(run('git', ['init', '-q'], repo)).toBe(0);
    run('git', ['config', 'user.email', 'test@example.com'], repo);
    run('git', ['config', 'user.name', 'Test'], repo);
    run('git', ['commit', '--allow-empty', '-q', '-m', 'root'], repo);

    const plan = planContribution(cleanSession(), { ...BASE, targetRepo: repo });
    const staged = stageContribution(plan, { ...BASE, targetRepo: repo });
    expect(staged.committed).toBe(true);

    // The commit exists on the contribution branch and touched the record file.
    const branch = captured('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    expect(branch).toBe('contrib/USERNAME_1/sess-abc123');
    const files = captured('git', ['show', '--name-only', '--format=', 'HEAD'], repo);
    expect(files).toContain('data/0.1.0/USERNAME_1/sess-abc123.jsonl');
  });
});

// Small local exec helpers for the real-git integration test.
import { spawnSync } from 'node:child_process';
function run(cmd: string, args: string[], cwd: string): number {
  return spawnSync(cmd, args, { cwd, encoding: 'utf-8' }).status ?? 1;
}
function captured(cmd: string, args: string[], cwd: string): string {
  return spawnSync(cmd, args, { cwd, encoding: 'utf-8' }).stdout ?? '';
}
