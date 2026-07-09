import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type AsyncCommandRunner,
  type CommandRunner,
  type RunResult,
  ghAuthenticatedAsync,
  planContribution,
  planContributionAsync,
  stageContribution,
  stageContributionAsync,
} from '../index.js';
import { SANITIZER_PACKAGE_VERSION, cleanSession } from './_fixtures.js';

/** Presence/auth knobs shared by the sync + async fakes so both paths compare. */
interface Presence {
  gh?: boolean;
  git?: boolean;
  /** `gh auth status` exit (only meaningful when gh is present). */
  ghAuthed?: boolean;
}

function reply(command: string, args: string[], p: Presence): RunResult {
  if (command === 'gh' && args[0] === '--version') {
    return { code: p.gh ? 0 : 127, stdout: '', stderr: '' };
  }
  if (command === 'git' && args[0] === '--version') {
    return { code: p.git === false ? 127 : 0, stdout: 'git version 2', stderr: '' };
  }
  if (command === 'gh' && args[0] === 'auth' && args[1] === 'status') {
    return { code: p.ghAuthed ? 0 : 1, stdout: '', stderr: p.ghAuthed ? '' : 'not logged in' };
  }
  return { code: 0, stdout: '', stderr: '' };
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly p: Presence = {}) {}
  run(command: string, args: string[]): RunResult {
    this.calls.push({ command, args });
    return reply(command, args, this.p);
  }
}

class FakeAsyncRunner implements AsyncCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly p: Presence = {}) {}
  async runAsync(command: string, args: string[]): Promise<RunResult> {
    this.calls.push({ command, args });
    return reply(command, args, this.p);
  }
}

const BASE = { sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION };

const tmpDirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mosga-async-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** The git verbs (dropping `--version` probes) a runner issued, in order. */
function gitVerbs(calls: Array<{ command: string; args: string[] }>): string[] {
  return calls.filter((c) => c.command === 'git' && c.args[0] !== '--version').map((c) => c.args[0]);
}

describe('async command runner mirrors the sync path', () => {
  it('async stage issues the same git command sequence as sync for a clean artifact', async () => {
    const syncRepo = tempRepo();
    const syncRunner = new FakeRunner({ gh: false, git: true });
    const syncPlan = planContribution(cleanSession(), { ...BASE, targetRepo: syncRepo, runner: syncRunner });
    const syncStaged = stageContribution(syncPlan, { ...BASE, targetRepo: syncRepo, runner: syncRunner });

    const asyncRepo = tempRepo();
    const asyncRunner = new FakeAsyncRunner({ gh: false, git: true });
    const asyncPlan = await planContributionAsync(cleanSession(), {
      ...BASE,
      targetRepo: asyncRepo,
      asyncRunner,
    });
    const asyncStaged = await stageContributionAsync(asyncPlan, {
      ...BASE,
      targetRepo: asyncRepo,
      asyncRunner,
    });

    expect(asyncPlan.branch).toBe(syncPlan.branch);
    expect(asyncPlan.commands).toEqual(syncPlan.commands);
    expect(asyncPlan.ghAvailable).toBe(false);
    expect(asyncStaged.committed).toBe(syncStaged.committed);
    // The git verbs match: branch → add → commit (no push, no gh pr create).
    expect(gitVerbs(asyncRunner.calls)).toEqual(gitVerbs(syncRunner.calls));
    expect(gitVerbs(asyncRunner.calls)).toEqual(['checkout', 'add', 'commit']);
  });

  it('planContributionAsync detects gh presence via the async runner', async () => {
    const repo = tempRepo();
    const plan = await planContributionAsync(cleanSession(), {
      ...BASE,
      targetRepo: repo,
      asyncRunner: new FakeAsyncRunner({ gh: true, git: true }),
    });
    expect(plan.ghAvailable).toBe(true);
  });

  it('ghAuthenticatedAsync distinguishes present-unauthenticated from present-authenticated', async () => {
    expect(await ghAuthenticatedAsync(new FakeAsyncRunner({ gh: true, ghAuthed: true }))).toBe(true);
    // gh present but `gh auth status` non-zero → not authenticated (distinct from absent).
    expect(await ghAuthenticatedAsync(new FakeAsyncRunner({ gh: true, ghAuthed: false }))).toBe(false);
  });
});
