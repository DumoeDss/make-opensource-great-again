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
 * Fake async git/gh runner mirroring `publish.test.ts`: records every command,
 * returns canned results, and a `hold` gate freezes the first mutating command so
 * the single-flight mutex is exercised deterministically. NO real git/gh/network.
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

const postJson = (base: string, url: string, body: unknown): Promise<Response> =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const postBare = (base: string, url: string): Promise<Response> =>
  fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' } });

describe('批量 出口① publish routes', () => {
  let home: string;
  let cwd: string;
  let dataRepo: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    dataRepo = makeTempDir('mosga-datarepo-');
    // Two sessions that each unlock to CLEAN bytes when the secret is REPLACED.
    writeSession(home, 'projA', 'sess-projA', cwd, [secretTurn('a1'), plainTurn('a2', 'all good now')]);
    writeSession(home, 'projB', 'sess-projB', cwd, [secretTurn('b1'), plainTurn('b2', 'all good now')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
    rm(dataRepo);
  });

  it('plan returns a batch UI-safe subset (N records, no record bytes)', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/plan', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      const body = JSON.parse(raw) as {
        branch: string;
        recordCount: number;
        totalRecordBytes: number;
        records: Array<{ sessionId: string; recordBytes: number; contentHash: string; messages: number }>;
        compareUrl: string;
      };
      expect(body.recordCount).toBe(2);
      expect(body.branch).toMatch(/^contrib\/USER_1\/batch-[0-9a-f]{8}$/);
      expect(body.records).toHaveLength(2);
      expect(body.records[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.totalRecordBytes).toBeGreaterThan(0);
      expect(body.compareUrl).toContain('/compare/main...');
      // No raw record bytes in the subset.
      expect(body.records[0]).not.toHaveProperty('fileContents');
      expect(body.records[0]).not.toHaveProperty('jsonl');
      expect(raw).not.toContain('AKIA');
      expect(raw).not.toContain('ghp_');
    });
  });

  it('plan names an unknown review with a 404', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const res = await postJson(base, '/api/publish/batch/plan', {
        reviewIds: [rA.reviewId, 'nope'],
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { reviewId: string }).reviewId).toBe('nope');
    });
  });

  it('stage names the locked review in a 409 GATE_LOCKED and runs no git mutation', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB'); // left locked

      const res = await postJson(base, '/api/publish/batch/stage', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; reviewId: string };
      expect(body.code).toBe('GATE_LOCKED');
      expect(body.reviewId).toBe(rB.reviewId);
      // No branch/commit ran (the gate check precedes any mutation).
      expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'checkout')).toBe(false);
    });
  });

  it('aggregates a batch pre-check refusal per session (rule counts only, no raw values)', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'allow'); // gate unlocks, secret survives → pre-check refuses
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'allow');

      const res = await postJson(base, '/api/publish/batch/plan', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(422);
      const raw = await res.text();
      const body = JSON.parse(raw) as {
        code: string;
        blockingBySession: Array<{ reviewId: string; sessionId: string; blockingByRule: Array<{ ruleId: string; count: number }> }>;
      };
      expect(body.code).toBe('precheck_refused');
      expect(body.blockingBySession.map((b) => b.reviewId).sort()).toEqual(
        [rA.reviewId, rB.reviewId].sort(),
      );
      expect(body.blockingBySession[0].blockingByRule[0]).toHaveProperty('ruleId');
      expect(body.blockingBySession[0].blockingByRule[0]).toHaveProperty('count');
      expect(raw).not.toContain('AKIA');
      expect(raw).not.toContain('ghp_');
    });
  });

  it('rejects an empty or oversized batch before any review or git work', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const empty = await postJson(base, '/api/publish/batch/plan', { reviewIds: [] });
      expect(empty.status).toBe(400);
      const oversized = await postJson(base, '/api/publish/batch/plan', {
        reviewIds: Array.from({ length: 21 }, (_, i) => `r${i}`),
      });
      expect(oversized.status).toBe(400);
      // Neither touched git.
      expect(runner.calls.length).toBe(0);
    });
  });

  it('stage writes one commit for N records and reports the batch branch + count', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/stage', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { staged: boolean; branch: string; recordCount: number };
      expect(body.staged).toBe(true);
      expect(body.recordCount).toBe(2);
      expect(body.branch).toMatch(/^contrib\/USER_1\/batch-[0-9a-f]{8}$/);
      const gitVerbs = runner.calls
        .filter((c) => c.command === 'git' && !['--version', 'status', 'show-ref', 'remote'].includes(c.args[0]))
        .map((c) => c.args[0]);
      expect(gitVerbs).toEqual(['checkout', 'add', 'commit']);
    });
  });

  it('submit stages-if-needed, pushes once, opens one PR, and returns recordCount', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/submit', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { opened: boolean; receipt: { recordCount: number } };
      expect(body.opened).toBe(true);
      expect(body.receipt.recordCount).toBe(2);
      expect(runner.calls.filter((c) => c.command === 'git' && c.args[0] === 'push')).toHaveLength(1);
      expect(runner.calls.some((c) => c.command === 'gh' && c.args[0] === 'pr')).toBe(true);
    });
  });

  it('submit does NOT re-stage when the batch is already staged', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      await postJson(base, '/api/publish/batch/stage', { reviewIds: [rA.reviewId, rB.reviewId] });
      const checkoutsAfterStage = runner.calls.filter(
        (c) => c.command === 'git' && c.args[0] === 'checkout',
      ).length;
      const res = await postJson(base, '/api/publish/batch/submit', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(200);
      // No second checkout -b: submit reused the existing stage (batchKey match).
      const checkoutsAfterSubmit = runner.calls.filter(
        (c) => c.command === 'git' && c.args[0] === 'checkout',
      ).length;
      expect(checkoutsAfterSubmit).toBe(checkoutsAfterStage);
    });
  });

  it('stage is 409 repo_dirty when the working tree is not clean', async () => {
    const runner = new FakeAsyncRunner();
    runner.dirty = true;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/stage', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('repo_dirty');
    });
  });

  it('submit is 409 gh_unauthenticated when gh is present but not logged in', async () => {
    const runner = new FakeAsyncRunner();
    runner.gh = true;
    runner.ghAuthed = false;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/submit', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('gh_unauthenticated');
    });
  });

  it('submit is 409 push_rejected when the remote rejects the push', async () => {
    const runner = new FakeAsyncRunner();
    runner.pushRejected = true;
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const res = await postJson(base, '/api/publish/batch/submit', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('push_rejected');
    });
  });

  it('a fresh batch stage hitting the existing batch branch guides without deleting it', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      // Learn the deterministic batch branch, then pre-seed it as stale residue.
      const plan = (await (
        await postJson(base, '/api/publish/batch/plan', { reviewIds: [rA.reviewId, rB.reviewId] })
      ).json()) as { branch: string };
      runner.existingBranches.add(plan.branch);

      const res = await postJson(base, '/api/publish/batch/stage', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; branch: string };
      expect(body.code).toBe('branch_exists');
      expect(body.branch).toBe(plan.branch);
      expect(runner.calls.some((c) => c.command === 'git' && c.args[0] === 'branch')).toBe(false);
    });
  });

  it('a batch stage in flight blocks a concurrent per-review stage (shared mutex)', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const release = runner.hold();
      const first = postJson(base, '/api/publish/batch/stage', { reviewIds: [rA.reviewId, rB.reviewId] });
      await new Promise((r) => setTimeout(r, 60));
      const second = await postBare(base, `/api/reviews/${rA.reviewId}/publish/stage`);
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe('publish_in_flight');
      release();
      expect((await first).status).toBe(200);
    });
  });

  it('a per-review stage in flight blocks a concurrent batch stage (shared mutex)', async () => {
    const runner = new FakeAsyncRunner();
    await withServer({ homeDir: home, now: NOW, dataRepoPath: dataRepo, publishRunner: runner }, async (base) => {
      const rA = await createReview(base, 'projA');
      await unlock(base, rA, 'replace');
      const rB = await createReview(base, 'projB');
      await unlock(base, rB, 'replace');

      const release = runner.hold();
      const first = postBare(base, `/api/reviews/${rA.reviewId}/publish/stage`);
      await new Promise((r) => setTimeout(r, 60));
      const second = await postJson(base, '/api/publish/batch/stage', {
        reviewIds: [rA.reviewId, rB.reviewId],
      });
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe('publish_in_flight');
      release();
      expect((await first).status).toBe(200);
    });
  });
});
