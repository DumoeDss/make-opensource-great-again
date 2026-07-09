/**
 * 出口①「公开数据集」publish routes. The daemon mutates the operator's LOCAL
 * data-repo clone (writes the record + provenance + PR body, creates a
 * deterministic branch, commits, pushes, opens a PR via `gh`), so the unhappy
 * paths — locked gate, unconfigured repo, dirty tree, stale deterministic branch,
 * `gh` present-but-unauthenticated, push rejected — are modelled as typed error
 * codes to the standard of `/submit`.
 *
 * Every git/gh subprocess runs through an injected async runner so it never
 * blocks the daemon event loop. A single in-flight mutex serialises stage/submit
 * (one local user); plan is read-only and not mutexed. The `dataRepoPath` is
 * trusted startup config (never HTTP-writable) and is never echoed over HTTP.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { applyDispositions, type Finding } from '@mosga/sanitizer';
import {
  type AsyncCommandRunner,
  type BatchContributionPlan,
  type ContributionPlan,
  BatchPublishRefusedError,
  PublishRefusedError,
  ghAuthenticatedAsync,
  isGhAvailableAsync,
  isGitAvailableAsync,
  planBatchContributionAsync,
  planContributionAsync,
  stageBatchContributionAsync,
  stageContributionAsync,
  submitBatchContributionAsync,
  submitContributionAsync,
} from '@mosga/publisher';
import { z } from 'zod';

import type { HandlerResult, Route } from './http.js';
import type { ReviewStore } from './reviews.js';

/** Batch publish request body: 1–20 reviewIds (deduped downstream). */
const BatchReviewIdsBody = z.object({ reviewIds: z.array(z.string()).min(1).max(20) });

/** Rule-aggregated blocking counts — never the raw matched values (leak guard). */
function aggregateBlockingByRule(findings: Finding[]): Array<{ ruleId: string; count: number }> {
  const byRule = new Map<string, number>();
  for (const f of findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  return [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count }));
}

/** Dedupe reviewIds preserving first-seen order. */
function dedupeReviewIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Stage-state key for a batch: the sorted deduped reviewIds joined with `,`. For
 * N=1 the key IS the reviewId, so a batch of one deliberately SHARES stage state
 * (and thus the deterministic branch/residue semantics) with the per-review route.
 */
function batchKeyOf(dedupedIds: string[]): string {
  return [...dedupedIds].sort().join(',');
}

export interface PublishDeps {
  store: ReviewStore;
  /** Trusted server-side data-repo clone path (startup config; never HTTP-writable). */
  dataRepoPath?: string;
  /** Async git/gh runner (injected in tests; defaults to the spawn-based runner). */
  runner: AsyncCommandRunner;
  /** The daemon's compiled ruleset (custom rules baked in) for the pre-check parity. */
  getRuleset: () => import('@mosga/sanitizer').CompiledRuleset;
  /** Deterministic time override for tests. */
  now?: string;
}

/** Per-review stage state: whether we have staged, and under which branch. */
interface StageState {
  staged: boolean;
  branch: string;
}

function pubError(status: number, code: string, extra: Record<string, unknown> = {}): HandlerResult {
  return { status, json: { error: extra.error ?? code, code, ...extra } };
}

/** The UI-safe subset of a plan: enumerated fields only, record bytes EXCLUDED. */
function uiSafePlan(plan: ContributionPlan, compareUrl: string | null): Record<string, unknown> {
  const recordBytes = Buffer.byteLength(plan.record.fileContents, 'utf-8');
  const contentHash = createHash('sha256').update(plan.record.fileContents, 'utf-8').digest('hex');
  return {
    branch: plan.branch,
    targetBranch: plan.targetBranch,
    recordPath: plan.recordPath,
    provenancePath: plan.provenancePath,
    prTitle: plan.prTitle,
    prBody: plan.prBody,
    commitMessage: plan.commitMessage,
    recordCount: plan.recordCount,
    ghAvailable: plan.ghAvailable,
    stagedFiles: plan.stagedFiles,
    commands: plan.commands,
    provenance: plan.provenance,
    engine: plan.engine,
    compareUrl,
    recordBytes,
    contentHash,
  };
}

/**
 * Normalise an `origin` remote URL to a GitHub `owner/repo` pair, or `null` when
 * it is absent or not GitHub. Handles the SSH (`git@github.com:owner/repo.git`),
 * `ssh://`, and HTTPS (`https://github.com/owner/repo(.git)`) forms.
 */
function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;
  // scp-like SSH: git@github.com:owner/repo.git
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  // ssh:// or https:// URL forms
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, '');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

export function createPublishRoutes(deps: PublishDeps): Route[] {
  const { store, runner } = deps;
  // Stage state + single-flight mutex live in this closure (one local user).
  const stageState = new Map<string, StageState>();
  let publishInFlight = false;

  /** Is the data repo configured AND an existing directory on disk? */
  function dataRepoConfigured(): boolean {
    const p = deps.dataRepoPath;
    if (!p) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** Empty `git status --porcelain` in the clone ⇒ a clean working tree. */
  async function isRepoClean(): Promise<boolean> {
    const res = await runner.runAsync('git', ['status', '--porcelain'], { cwd: deps.dataRepoPath });
    return res.code === 0 && res.stdout.trim().length === 0;
  }

  /** Does the deterministic contribution branch already exist locally? */
  async function branchExists(branch: string): Promise<boolean> {
    const res = await runner.runAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: deps.dataRepoPath,
    });
    return res.code === 0;
  }

  /** Derive a GitHub compare URL from the clone's `origin` remote, or `null`. */
  async function deriveCompareUrl(targetBranch: string, branch: string): Promise<string | null> {
    const res = await runner.runAsync('git', ['remote', 'get-url', 'origin'], { cwd: deps.dataRepoPath });
    if (res.code !== 0) return null;
    const parsed = parseGitHubOwnerRepo(res.stdout);
    if (!parsed) return null;
    return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${targetBranch}...${branch}?expand=1`;
  }

  /**
   * Derive the stamped session for a review, or an error result. Mirrors
   * `/export`: 404 for an unknown review, 409 when the gate is locked.
   */
  function stampedSessionFor(reviewId: string):
    | { ok: true; session: import('@mosga/contracts').SanitizedSession }
    | { ok: false; result: HandlerResult } {
    const state = store.get(reviewId);
    if (!state) {
      return { ok: false, result: { status: 404, json: { error: `unknown review "${reviewId}"` } } };
    }
    const applied = applyDispositions(state.session, state.report, state.mapper);
    if (!applied.gate.unlocked) {
      return {
        ok: false,
        result: {
          status: 409,
          json: {
            error: 'gate is locked; disposition all blocking + non-text items first',
            code: 'GATE_LOCKED',
            gate: applied.gate,
          },
        },
      };
    }
    return { ok: true, session: applied.session };
  }

  /** Run the plan (export + MANDATORY pre-check) mapping a refusal to a typed code. */
  async function computePlan(
    session: import('@mosga/contracts').SanitizedSession,
  ): Promise<{ ok: true; plan: ContributionPlan } | { ok: false; result: HandlerResult }> {
    try {
      const plan = await planContributionAsync(session, {
        targetRepo: deps.dataRepoPath as string,
        ruleset: deps.getRuleset(),
        asyncRunner: runner,
        now: deps.now,
        generatedAt: deps.now,
      });
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof PublishRefusedError) {
        // Rule-aggregated counts ONLY — never the raw matched values.
        return {
          ok: false,
          result: pubError(422, 'precheck_refused', {
            error: 'publication refused: the pre-check found surviving blocking findings',
            blockingByRule: aggregateBlockingByRule(err.blockingFindings),
          }),
        };
      }
      throw err;
    }
  }

  /**
   * Stamp every review in a batch, mirroring `stampedSessionFor`. The FIRST
   * failure returns immediately with the offending `reviewId` merged into the
   * error json (unknown → 404, locked gate → 409 `GATE_LOCKED` + gate).
   */
  function stampedBatch(reviewIds: string[]):
    | { ok: true; items: Array<{ reviewId: string; session: import('@mosga/contracts').SanitizedSession }> }
    | { ok: false; result: HandlerResult } {
    const items: Array<{ reviewId: string; session: import('@mosga/contracts').SanitizedSession }> = [];
    for (const reviewId of reviewIds) {
      const stamped = stampedSessionFor(reviewId);
      if (!stamped.ok) {
        return {
          ok: false,
          result: {
            status: stamped.result.status,
            json: { ...(stamped.result.json as Record<string, unknown>), reviewId },
          },
        };
      }
      items.push({ reviewId, session: stamped.session });
    }
    return { ok: true, items };
  }

  /** Batch plan (export + aggregated MANDATORY pre-check), mapping refusals to 422. */
  async function computeBatchPlan(
    items: Array<{ reviewId: string; session: import('@mosga/contracts').SanitizedSession }>,
  ): Promise<{ ok: true; plan: BatchContributionPlan } | { ok: false; result: HandlerResult }> {
    try {
      const plan = await planBatchContributionAsync(
        items.map((i) => i.session),
        {
          targetRepo: deps.dataRepoPath as string,
          ruleset: deps.getRuleset(),
          asyncRunner: runner,
          now: deps.now,
          generatedAt: deps.now,
        },
      );
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof BatchPublishRefusedError) {
        // Per refused session: its reviewId + rule-aggregated counts (no raw values).
        const reviewIdBySession = new Map(items.map((i) => [i.session.session.sessionId, i.reviewId]));
        const blockingBySession = err.refusals.map((r) => ({
          reviewId: reviewIdBySession.get(r.sessionId),
          sessionId: r.sessionId,
          blockingByRule: aggregateBlockingByRule(r.blockingFindings),
        }));
        return {
          ok: false,
          result: pubError(422, 'precheck_refused', {
            error: 'batch publication refused: the pre-check found surviving blocking findings',
            blockingBySession,
          }),
        };
      }
      throw err;
    }
  }

  /** The UI-safe subset of a batch plan: per-record metadata + totals, record bytes EXCLUDED. */
  function uiSafeBatchPlan(plan: BatchContributionPlan, compareUrl: string | null): Record<string, unknown> {
    const records = plan.records.map((record) => ({
      sessionId: record.session.session.sessionId,
      recordPath: record.recordPath,
      provenancePath: record.provenancePath,
      recordBytes: Buffer.byteLength(record.fileContents, 'utf-8'),
      contentHash: createHash('sha256').update(record.fileContents, 'utf-8').digest('hex'),
      messages: record.session.messages.length,
    }));
    return {
      branch: plan.branch,
      targetBranch: plan.targetBranch,
      prTitle: plan.prTitle,
      prBody: plan.prBody,
      commitMessage: plan.commitMessage,
      recordCount: plan.recordCount,
      ghAvailable: plan.ghAvailable,
      stagedFiles: plan.stagedFiles,
      commands: plan.commands,
      engine: plan.engine,
      compareUrl,
      totalRecordBytes: records.reduce((n, r) => n + r.recordBytes, 0),
      records,
    };
  }

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: '/api/publish/preflight',
      handler: async () => {
        const gitAvailable = await isGitAvailableAsync(runner);
        const ghAvailable = await isGhAvailableAsync(runner);
        const ghAuthenticated = ghAvailable ? await ghAuthenticatedAsync(runner) : false;
        const configured = dataRepoConfigured();
        const repoClean = configured && gitAvailable ? await isRepoClean() : false;
        return {
          status: 200,
          json: {
            dataRepoConfigured: configured,
            gitAvailable,
            ghAvailable,
            ghAuthenticated,
            repoClean,
          },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/publish/plan',
      handler: async ({ params }) => {
        // Plan is read-only (no disk write, no git mutation) → not mutexed.
        if (!dataRepoConfigured()) return pubError(409, 'data_repo_unconfigured');
        const stamped = stampedSessionFor(params.reviewId);
        if (!stamped.ok) return stamped.result;
        if (!(await isGitAvailableAsync(runner))) return pubError(409, 'git_unavailable');

        const planned = await computePlan(stamped.session);
        if (!planned.ok) return planned.result;
        const compareUrl = await deriveCompareUrl(planned.plan.targetBranch, planned.plan.branch);
        return { status: 200, json: uiSafePlan(planned.plan, compareUrl) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/publish/stage',
      handler: async ({ params }) => {
        if (publishInFlight) return pubError(409, 'publish_in_flight');
        publishInFlight = true;
        try {
          const staged = await runStage(params.reviewId);
          return staged.result;
        } finally {
          publishInFlight = false;
        }
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/publish/submit',
      handler: async ({ params }) => {
        if (publishInFlight) return pubError(409, 'publish_in_flight');
        publishInFlight = true;
        try {
          // Stage-if-not-staged (per the in-memory flag), then push + open PR.
          const existing = stageState.get(params.reviewId);
          let plan: ContributionPlan;
          if (existing?.staged) {
            // Already staged by us — recompute the plan (deterministic) for the push.
            if (!dataRepoConfigured()) return pubError(409, 'data_repo_unconfigured');
            const stamped = stampedSessionFor(params.reviewId);
            if (!stamped.ok) return stamped.result;
            if (!(await isGitAvailableAsync(runner))) return pubError(409, 'git_unavailable');
            const planned = await computePlan(stamped.session);
            if (!planned.ok) return planned.result;
            plan = planned.plan;
          } else {
            const staged = await runStage(params.reviewId);
            if (!staged.ok) return staged.result;
            plan = staged.plan;
          }

          // gh must be present AND authenticated to open the PR automatically.
          if (!(await ghAuthenticatedAsync(runner))) {
            return pubError(409, 'gh_unauthenticated', {
              error: 'gh is not authenticated; run `gh auth login`, or use the manual push + compare-URL path',
            });
          }
          const result = await submitContributionAsync(plan, {
            targetRepo: deps.dataRepoPath as string,
            asyncRunner: runner,
          });
          if (result.pushRejected) {
            return pubError(409, 'push_rejected', {
              error: 'the remote rejected the push; pull/rebase the base branch and retry',
            });
          }
          if (!result.opened) {
            return { status: 500, json: { error: 'gh pr create failed', code: 'submit_failed' } };
          }
          const compareUrl = await deriveCompareUrl(plan.targetBranch, plan.branch);
          return {
            status: 200,
            json: {
              opened: true,
              branch: plan.branch,
              receipt: {
                branch: plan.branch,
                targetBranch: plan.targetBranch,
                prTitle: plan.prTitle,
                compareUrl,
                submittedAt: deps.now ?? new Date().toISOString(),
              },
            },
          };
        } finally {
          publishInFlight = false;
        }
      },
    },

    // ---- Batch publish (出口① for N sessions as one branch/commit/PR) --------

    {
      method: 'POST',
      pattern: '/api/publish/batch/plan',
      handler: async ({ body }) => {
        // Size/shape validation runs before ANY review or git work.
        const parsed = BatchReviewIdsBody.safeParse(body);
        if (!parsed.success) return { status: 400, json: { error: parsed.error.message } };
        const reviewIds = dedupeReviewIds(parsed.data.reviewIds);
        // Plan is read-only (no disk write, no git mutation) → not mutexed.
        if (!dataRepoConfigured()) return pubError(409, 'data_repo_unconfigured');
        const batch = stampedBatch(reviewIds);
        if (!batch.ok) return batch.result;
        if (!(await isGitAvailableAsync(runner))) return pubError(409, 'git_unavailable');
        const planned = await computeBatchPlan(batch.items);
        if (!planned.ok) return planned.result;
        const compareUrl = await deriveCompareUrl(planned.plan.targetBranch, planned.plan.branch);
        return { status: 200, json: uiSafeBatchPlan(planned.plan, compareUrl) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/publish/batch/stage',
      handler: async ({ body }) => {
        const parsed = BatchReviewIdsBody.safeParse(body);
        if (!parsed.success) return { status: 400, json: { error: parsed.error.message } };
        const reviewIds = dedupeReviewIds(parsed.data.reviewIds);
        if (publishInFlight) return pubError(409, 'publish_in_flight');
        publishInFlight = true;
        try {
          const staged = await runBatchStage(reviewIds);
          return staged.result;
        } finally {
          publishInFlight = false;
        }
      },
    },

    {
      method: 'POST',
      pattern: '/api/publish/batch/submit',
      handler: async ({ body }) => {
        const parsed = BatchReviewIdsBody.safeParse(body);
        if (!parsed.success) return { status: 400, json: { error: parsed.error.message } };
        const reviewIds = dedupeReviewIds(parsed.data.reviewIds);
        if (publishInFlight) return pubError(409, 'publish_in_flight');
        publishInFlight = true;
        try {
          const batchKey = batchKeyOf(reviewIds);
          const existing = stageState.get(batchKey);
          let plan: BatchContributionPlan;
          if (existing?.staged) {
            // Already staged by us — recompute the (deterministic) plan for the push.
            if (!dataRepoConfigured()) return pubError(409, 'data_repo_unconfigured');
            const batch = stampedBatch(reviewIds);
            if (!batch.ok) return batch.result;
            if (!(await isGitAvailableAsync(runner))) return pubError(409, 'git_unavailable');
            const planned = await computeBatchPlan(batch.items);
            if (!planned.ok) return planned.result;
            plan = planned.plan;
          } else {
            const staged = await runBatchStage(reviewIds);
            if (!staged.ok) return staged.result;
            plan = staged.plan;
          }

          if (!(await ghAuthenticatedAsync(runner))) {
            return pubError(409, 'gh_unauthenticated', {
              error: 'gh is not authenticated; run `gh auth login`, or use the manual push + compare-URL path',
            });
          }
          const result = await submitBatchContributionAsync(plan, {
            targetRepo: deps.dataRepoPath as string,
            asyncRunner: runner,
          });
          if (result.pushRejected) {
            return pubError(409, 'push_rejected', {
              error: 'the remote rejected the push; pull/rebase the base branch and retry',
            });
          }
          if (!result.opened) {
            return { status: 500, json: { error: 'gh pr create failed', code: 'submit_failed' } };
          }
          const compareUrl = await deriveCompareUrl(plan.targetBranch, plan.branch);
          return {
            status: 200,
            json: {
              opened: true,
              branch: plan.branch,
              receipt: {
                branch: plan.branch,
                targetBranch: plan.targetBranch,
                prTitle: plan.prTitle,
                compareUrl,
                submittedAt: deps.now ?? new Date().toISOString(),
                recordCount: plan.recordCount,
              },
            },
          };
        } finally {
          publishInFlight = false;
        }
      },
    },
  ];

  /**
   * Shared stage sequence (assumes the caller holds the mutex). Order per design:
   * dataRepo → git → gate → repoClean → plan/precheck → branch collision → write+commit.
   * Returns the plan on success so `submit` can reuse it for the push.
   */
  async function runStage(
    reviewId: string,
  ): Promise<{ ok: true; plan: ContributionPlan; result: HandlerResult } | { ok: false; result: HandlerResult }> {
    if (!dataRepoConfigured()) return { ok: false, result: pubError(409, 'data_repo_unconfigured') };
    if (!(await isGitAvailableAsync(runner))) return { ok: false, result: pubError(409, 'git_unavailable') };
    const stamped = stampedSessionFor(reviewId);
    if (!stamped.ok) return { ok: false, result: stamped.result };
    if (!(await isRepoClean())) {
      return {
        ok: false,
        result: pubError(409, 'repo_dirty', {
          error: 'the data-repo working tree is not clean; commit, stash, or clean it, then retry',
        }),
      };
    }
    const planned = await computePlan(stamped.session);
    if (!planned.ok) return { ok: false, result: planned.result };
    const plan = planned.plan;

    // Fresh stage (no staged flag) hitting an existing deterministic branch is
    // stale residue from a prior attempt: guide, do NOT auto-clean.
    if (!stageState.get(reviewId)?.staged && (await branchExists(plan.branch))) {
      return {
        ok: false,
        result: pubError(409, 'branch_exists', {
          error: `the contribution branch "${plan.branch}" already exists; delete it to retry, or continue it manually`,
          branch: plan.branch,
        }),
      };
    }

    const stageResult = await stageContributionAsync(plan, {
      targetRepo: deps.dataRepoPath as string,
      asyncRunner: runner,
    });
    if (!stageResult.committed) {
      return {
        ok: false,
        result: { status: 500, json: { error: 'staging commit failed', code: 'stage_failed', log: stageResult.log } },
      };
    }
    stageState.set(reviewId, { staged: true, branch: plan.branch });
    return {
      ok: true,
      plan,
      result: {
        status: 200,
        json: {
          staged: true,
          branch: plan.branch,
          stagedFiles: plan.stagedFiles,
          recordPath: plan.recordPath,
        },
      },
    };
  }

  /**
   * Shared batch stage sequence (assumes the caller holds the mutex). Same check
   * order as the single `runStage`: dataRepo → git → per-review gate → repoClean →
   * batch plan/precheck → batch-branch collision → write+commit. Stage state is
   * keyed by the sorted deduped reviewIds. Returns the plan so `submit` can reuse it.
   */
  async function runBatchStage(
    reviewIds: string[],
  ): Promise<
    | { ok: true; plan: BatchContributionPlan; result: HandlerResult }
    | { ok: false; result: HandlerResult }
  > {
    if (!dataRepoConfigured()) return { ok: false, result: pubError(409, 'data_repo_unconfigured') };
    if (!(await isGitAvailableAsync(runner))) return { ok: false, result: pubError(409, 'git_unavailable') };
    const batch = stampedBatch(reviewIds);
    if (!batch.ok) return { ok: false, result: batch.result };
    if (!(await isRepoClean())) {
      return {
        ok: false,
        result: pubError(409, 'repo_dirty', {
          error: 'the data-repo working tree is not clean; commit, stash, or clean it, then retry',
        }),
      };
    }
    const planned = await computeBatchPlan(batch.items);
    if (!planned.ok) return { ok: false, result: planned.result };
    const plan = planned.plan;
    const batchKey = batchKeyOf(reviewIds);

    // A fresh stage hitting the existing deterministic batch branch is stale residue
    // from a prior attempt (identical keyed-residue semantics as the single route).
    if (!stageState.get(batchKey)?.staged && (await branchExists(plan.branch))) {
      return {
        ok: false,
        result: pubError(409, 'branch_exists', {
          error: `the contribution branch "${plan.branch}" already exists; delete it to retry, or continue it manually`,
          branch: plan.branch,
        }),
      };
    }

    const stageResult = await stageBatchContributionAsync(plan, {
      targetRepo: deps.dataRepoPath as string,
      asyncRunner: runner,
    });
    if (!stageResult.committed) {
      return {
        ok: false,
        result: { status: 500, json: { error: 'staging commit failed', code: 'stage_failed', log: stageResult.log } },
      };
    }
    stageState.set(batchKey, { staged: true, branch: plan.branch });
    return {
      ok: true,
      plan,
      result: {
        status: 200,
        json: {
          staged: true,
          branch: plan.branch,
          stagedFiles: plan.stagedFiles,
          recordCount: plan.recordCount,
        },
      },
    };
  }

  return routes;
}

/**
 * Validate a configured data-repo path at startup (exists + is a directory). A
 * bad path is an operator-console warning, NOT an HTTP error — preflight then
 * simply reports `dataRepoConfigured: false`. Mirrors `loadTrustedCustomRules`'s
 * "startup config error, never reachable from HTTP" discipline.
 */
export function validateDataRepoPath(dataRepoPath: string | undefined): void {
  if (!dataRepoPath) return;
  try {
    if (!fs.statSync(dataRepoPath).isDirectory()) {
      console.error(`[publish] --data-repo path is not a directory: ${dataRepoPath}`);
    }
  } catch {
    console.error(`[publish] --data-repo path does not exist: ${dataRepoPath}`);
  }
}
