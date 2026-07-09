import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AsyncCommandRunner, RunResult } from '@mosga/publisher';
import type { SanitizationReport } from '@mosga/sanitizer';

import { makeTempDir, plainTurn, rm, secretTurn, withServer, writeSession } from './_helpers.js';

const NOW = '2026-07-09T00:00:00.000Z';

interface Created {
  reviewId: string;
  report: SanitizationReport;
}

/**
 * A fully-configurable fake async git/gh runner: it records every command and
 * returns canned results — NO real git, gh, network, or disk mutation. A
 * `hold` gate lets a test freeze the first mutating command to exercise the
 * single-flight mutex deterministically.
 */
class FakeAsyncRunner implements AsyncCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  git = true;
  gh = true;
  ghAuthed = true;
  dirty = false;
  existingBranches = new Set<string>();
  remoteUrl: string | null = 'git@github.com:mosga/data.git';
  pushRejected = false;

  private held?: { promise: Promise<void>; release: () => void };

  /** Arm a one-shot gate that blocks the next `git --version` until released. */
  hold(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    this.held = { promise, release };
    return release;
  }

  async runAsync(command: string, args: string[]): Promise<RunResult> {
    this.calls.push({ command, args });
    if (command === 'git' && args[0] === '--version') {
      if (this.held) {
        const gate = this.held;
        this.held = undefined;
        await gate.promise;
      }
      return { code: this.git ? 0 : 127, stdout: 'git version 2', stderr: '' };
    }
    if (command === 'gh' && args[0] === '--version') {
      return { code: this.gh ? 0 : 127, stdout: '', stderr: '' };
    }
    if (command === 'gh' && args[0] === 'auth' && args[1] === 'status') {
      return { code: this.gh && this.ghAuthed ? 0 : 1, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { code: 0, stdout: this.dirty ? ' M some-file\n' : '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'show-ref') {
      const ref = args[args.length - 1];
      const branch = ref.replace('refs/heads/', '');
      return { code: this.existingBranches.has(branch) ? 0 : 1, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      if (this.remoteUrl === null) return { code: 1, stdout: '', stderr: 'no origin' };
      return { code: 0, stdout: `${this.remoteUrl}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'push') {
      return this.pushRejected
        ? { code: 1, stdout: '', stderr: 'rejected' }
        : { code: 0, stdout: '', stderr: '' };
    }
    // checkout / add / commit / gh pr create — succeed.
    return { code: 0, stdout: '', stderr: '' };
  }
}

async function createReview(base: string, projectKey: string): Promise<Created> {
  return (await (
    await fetch(`${base}/api/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'claude-code', projectKey, sessionId: `sess-${projectKey}` }),
    })
  ).json()) as Created;
}

/** Dispose every blocking finding + non-text item, unlocking the gate. */
async function unlock(base: string, r: Created, disposition = 'replace'): Promise<void> {
  for (const f of r.report.findings.filter((x) => x.blocking)) {
    await fetch(`${base}/api/reviews/${r.reviewId}/findings/${f.id}/disposition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition }),
    });
  }
  for (const n of r.report.nonTextItems) {
    await fetch(`${base}/api/reviews/${r.reviewId}/nontext/${n.messageUuid}/disposition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'remove' }),
    });
  }
}

const post = (base: string, url: string): Promise<Response> =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' } });

describe('出口① publish routes', () => {
  let home: string;
  let cwd: string;
  let dataRepo: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    dataRepo = makeTempDir('mosga-datarepo-');
    // A session that unlocks to CLEAN bytes when the secret is REPLACED.
    writeSession(home, 'projX', 'sess-projX', cwd, [secretTurn('u1'), plainTurn('u2', 'all good now')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
    rm(dataRepo);
  });

  it('GET /api/publish/preflight reports the five capability flags', async () => {
    const runner = new FakeAsyncRunner();
    runner.gh = true;
    runner.ghAuthed = false;
    await withServer({ homeDir: home, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const res = await fetch(`${base}/api/publish/preflight`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, boolean>;
      expect(body).toEqual({
        dataRepoConfigured: true,
        gitAvailable: true,
        ghAvailable: true,
        ghAuthenticated: false,
        repoClean: true,
      });
      // The literal path is NEVER echoed over HTTP.
      expect(JSON.stringify(body)).not.toContain(dataRepo);
    });
  });

  it('preflight reports dataRepoConfigured:false when no data repo is set', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, publishRunner: runner }, async (base) => {
      const body = (await (await fetch(`${base}/api/publish/preflight`)).json()) as Record<string, boolean>;
      expect(body.dataRepoConfigured).toBe(false);
      expect(body.repoClean).toBe(false);
    });
  });

  it('plan is 409 while the gate is locked', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/plan`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('GATE_LOCKED');
    });
  });

  it('plan returns the UI-safe subset (compareUrl + record summary, no record bytes)', async () => {
    const runner = new FakeAsyncRunner();
    runner.remoteUrl = 'git@github.com:mosga/data.git';
    await withServer(
      { homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner },
      async (base) => {
        const r = await createReview(base, 'projX');
        await unlock(base, r, 'replace');
        const res = await post(base, `/api/reviews/${r.reviewId}/publish/plan`);
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw) as Record<string, unknown>;
        expect(body.branch).toBe('contrib/USER_1/sess-projX');
        expect(body.recordBytes).toBeGreaterThan(0);
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(body.compareUrl).toBe(
          'https://github.com/mosga/data/compare/main...contrib/USER_1/sess-projX?expand=1',
        );
        // The serialized record bytes are EXCLUDED from the UI-safe subset.
        expect(body).not.toHaveProperty('record');
        expect(Object.keys(body)).toEqual(
          expect.arrayContaining(['prBody', 'prTitle', 'stagedFiles', 'commands', 'provenance', 'engine']),
        );
      },
    );
  });

  it('plan compareUrl is null when origin is absent or non-GitHub', async () => {
    const runner = new FakeAsyncRunner();
    runner.remoteUrl = null;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const body = (await (await post(base, `/api/reviews/${r.reviewId}/publish/plan`)).json()) as {
        compareUrl: string | null;
      };
      expect(body.compareUrl).toBeNull();
    });
  });

  it('plan maps a surviving blocking finding to precheck_refused (rule-aggregated, no raw values)', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      // 'allow' unlocks the gate but leaves the raw secret in the bytes → the
      // MANDATORY pre-check re-scan refuses.
      await unlock(base, r, 'allow');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/plan`);
      expect(res.status).toBe(422);
      const raw = await res.text();
      const body = JSON.parse(raw) as { code: string; blockingByRule: Array<{ ruleId: string; count: number }> };
      expect(body.code).toBe('precheck_refused');
      expect(body.blockingByRule.length).toBeGreaterThan(0);
      expect(body.blockingByRule[0]).toHaveProperty('ruleId');
      expect(body.blockingByRule[0]).toHaveProperty('count');
      // No raw matched value ever appears (the canary secret is AKIA…/ghp_…).
      expect(raw).not.toContain('AKIA');
      expect(raw).not.toContain('ghp_');
    });
  });

  it('plan is 409 data_repo_unconfigured when no data repo is set', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/plan`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('data_repo_unconfigured');
    });
  });

  it('stage writes the commit and records the staged flag + branch', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { staged: boolean; branch: string; stagedFiles: string[] };
      expect(body.staged).toBe(true);
      expect(body.branch).toBe('contrib/USER_1/sess-projX');
      // The git verbs were checkout → add → commit (no push / gh pr create).
      const gitVerbs = runner.calls
        .filter((c) => c.command === 'git' && !['--version', 'status', 'show-ref', 'remote'].includes(c.args[0]))
        .map((c) => c.args[0]);
      expect(gitVerbs).toEqual(['checkout', 'add', 'commit']);
    });
  });

  it('stage is 409 repo_dirty when the working tree is not clean', async () => {
    const runner = new FakeAsyncRunner();
    runner.dirty = true;
    await withServer({ homeDir: home, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('repo_dirty');
    });
  });

  it('a fresh stage hitting an existing branch guides without deleting it', async () => {
    const runner = new FakeAsyncRunner();
    runner.existingBranches.add('contrib/USER_1/sess-projX');
    await withServer({ homeDir: home, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; branch: string };
      expect(body.code).toBe('branch_exists');
      expect(body.branch).toBe('contrib/USER_1/sess-projX');
      // NO auto-clean: no branch -D / -d was ever issued.
      expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'branch')).toBe(false);
    });
  });

  it('submit stages-if-not-staged, then pushes + opens the PR', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/submit`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { opened: boolean; branch: string };
      expect(body.opened).toBe(true);
      // Since it was not pre-staged, submit staged first: checkout/add/commit ran.
      const verbs = runner.calls.filter((c) => c.command === 'git').map((c) => c.args[0]);
      expect(verbs).toContain('checkout');
      expect(verbs).toContain('push');
      expect(runner.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr')).toBe(true);
    });
  });

  it('submit does NOT re-stage when the review is already staged', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      await post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      const checkoutsAfterStage = runner.calls.filter(
        (c) => c.command === 'git' && c.args[0] === 'checkout',
      ).length;
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/submit`);
      expect(res.status).toBe(200);
      // No second checkout -b: submit reused the existing stage.
      const checkoutsAfterSubmit = runner.calls.filter(
        (c) => c.command === 'git' && c.args[0] === 'checkout',
      ).length;
      expect(checkoutsAfterSubmit).toBe(checkoutsAfterStage);
    });
  });

  it('submit is 409 gh_unauthenticated when gh is present but not logged in', async () => {
    const runner = new FakeAsyncRunner();
    runner.gh = true;
    runner.ghAuthed = false;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/submit`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('gh_unauthenticated');
    });
  });

  it('submit is 409 push_rejected when the remote rejects the push', async () => {
    const runner = new FakeAsyncRunner();
    runner.pushRejected = true;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      const res = await post(base, `/api/reviews/${r.reviewId}/publish/submit`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('push_rejected');
    });
  });

  it('a concurrent publish is rejected with publish_in_flight', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const r = await createReview(base, 'projX');
      await unlock(base, r, 'replace');
      // Freeze the first stage inside the mutex (blocks on git --version).
      const release = runner.hold();
      const first = post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      // Give the first request time to enter the handler and acquire the mutex.
      await new Promise((res) => setTimeout(res, 60));
      const second = await post(base, `/api/reviews/${r.reviewId}/publish/stage`);
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe('publish_in_flight');
      release();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    });
  });
});
