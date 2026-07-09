/**
 * Batch contribution: plan/stage/submit N stamped sessions as ONE branch, ONE
 * commit, ONE PR (design B3). The single-session path (`pr.ts`) is unchanged; a
 * batch of exactly one degrades to it byte-for-byte by delegating to
 * `planContributionAsync` and wrapping the result in the batch shape.
 *
 * The MANDATORY pre-check runs on EVERY record's exact bytes with NO fail-fast:
 * refusals aggregate across all sessions into a single `BatchPublishRefusedError`
 * so the UI can surface every refused session at once. Alias consistency and
 * sessionId uniqueness are asserted up front (a mismatch/collision is a config
 * error, never silently resolved). Async-only — the daemon never blocks its loop.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { type SanitizedSession } from '@mosga/contracts';
import { type Finding } from '@mosga/sanitizer';

import { type ExportedRecord, exportSession, slugifyPathComponent } from './export.js';
import { assertPrecheckClean, PublishRefusedError } from './precheck.js';
import { type EngineInfo } from './provenance.js';
import {
  type ContributionOptions,
  type RunPrResult,
  PR_BODY_FILE,
  planContributionAsync,
  shellQuote,
  writeRepoFile,
} from './pr.js';
import {
  defaultAsyncRunner,
  isGhAvailableAsync,
  isGitAvailableAsync,
} from './runner.js';

/** A fully-planned batch contribution: N records under one branch/commit/PR. */
export interface BatchContributionPlan {
  /** The exported records (serialized bytes + per-record provenance), in input order. */
  records: ExportedRecord[];
  /** Deterministic branch: `contrib/<alias>/batch-<hash8>` (or the single branch for N=1). */
  branch: string;
  /** Base branch the PR targets. */
  targetBranch: string;
  /** PR title. */
  prTitle: string;
  /** Rendered PR body (markdown) with the per-session summary table. */
  prBody: string;
  /** Commit message (first line + body). */
  commitMessage: string;
  /** The shared engine identity every record's pre-check ran under (asserted identical). */
  engine: EngineInfo;
  /** Number of records (= sessions). */
  recordCount: number;
  /** Whether the `gh` CLI is available for an automated push + PR open. */
  ghAvailable: boolean;
  /** Repo-relative files committed: N×(record + provenance sidecar). */
  stagedFiles: string[];
  /** The exact `git`/`gh` command sequence for the manual path (one branch/commit/PR). */
  commands: string[];
}

/**
 * Raised when the batch pre-check refuses one or more sessions. Carries the
 * per-session blocking findings for EVERY refused session (no fail-fast) so the
 * caller can report them all at once. Nothing is planned, written, or staged.
 */
export class BatchPublishRefusedError extends Error {
  readonly refusals: Array<{ sessionId: string; blockingFindings: Finding[] }>;
  constructor(refusals: Array<{ sessionId: string; blockingFindings: Finding[] }>) {
    const ids = refusals.map((r) => r.sessionId);
    super(
      `batch publication refused: the pre-check re-scan found surviving blocking findings in ` +
        `${refusals.length} session(s) [${ids.join(', ')}]; nothing planned, written, or staged.`,
    );
    this.name = 'BatchPublishRefusedError';
    this.refusals = refusals;
  }
}

/** The write result of `stageBatchContributionAsync` (mirrors `StageResult`, N records). */
export interface BatchStageResult {
  committed: boolean;
  branch: string;
  stagedFiles: string[];
  /** Absolute paths of the written record files, in input order. */
  recordAbsolutePaths: string[];
  log: string;
}

/**
 * Plan a batch PR contribution. Runs export + the MANDATORY pre-check on every
 * session, aggregating refusals into `BatchPublishRefusedError`. On a clean pass it
 * computes the deterministic branch, per-session PR body table, and the single
 * `git`/`gh` command sequence — all in memory, touching no disk and running no git.
 *
 * A batch of one degrades to `planContributionAsync` (byte-identical branch/title/
 * body/commands), so the daemon's N=1 batch route matches the per-review route.
 */
export async function planBatchContributionAsync(
  sessions: SanitizedSession[],
  options: ContributionOptions,
): Promise<BatchContributionPlan> {
  if (sessions.length === 0) {
    throw new Error('batch contribution requires at least one session');
  }

  // Alias consistency: all sessions in a batch share one contributorAlias (they
  // come from one local envelope source). A mismatch is a config error, not a
  // silent "pick the first".
  const aliases = [...new Set(sessions.map((s) => s.meta.contributorAlias))];
  if (aliases.length > 1) {
    throw new Error(
      `batch contribution requires a single contributorAlias; got ${aliases
        .map((a) => JSON.stringify(a))
        .join(', ')}`,
    );
  }

  // Uniqueness: two same-id records would collide on the deterministic recordPath.
  const ids = sessions.map((s) => s.session.sessionId);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new Error(
      `batch contribution has a duplicate sessionId "${duplicate}"; each session must be unique`,
    );
  }

  // N=1 degrades to the single-session plan, wrapped into the batch shape. A single
  // refusal is normalised to BatchPublishRefusedError so callers see one refusal type.
  if (sessions.length === 1) {
    try {
      const single = await planContributionAsync(sessions[0], options);
      return {
        records: [single.record],
        branch: single.branch,
        targetBranch: single.targetBranch,
        prTitle: single.prTitle,
        prBody: single.prBody,
        commitMessage: single.commitMessage,
        engine: single.engine,
        recordCount: 1,
        ghAvailable: single.ghAvailable,
        stagedFiles: single.stagedFiles,
        commands: single.commands,
      };
    } catch (err) {
      if (err instanceof PublishRefusedError) {
        throw new BatchPublishRefusedError([
          { sessionId: sessions[0].session.sessionId, blockingFindings: err.blockingFindings },
        ]);
      }
      throw err;
    }
  }

  // 1. Export every session (serialize + provenance). Refuses an un-stamped session.
  const records = sessions.map((session) =>
    exportSession(session, {
      sanitizerPackageVersion: options.sanitizerPackageVersion,
      gitleaksVersion: options.gitleaksVersion,
    }),
  );

  // 2. MANDATORY pre-check on each record's EXACT bytes. NO fail-fast: collect
  //    every refusal, then throw once so the UI can show them all together.
  const refusals: Array<{ sessionId: string; blockingFindings: Finding[] }> = [];
  let engine: EngineInfo | undefined;
  for (let i = 0; i < records.length; i += 1) {
    try {
      const result = assertPrecheckClean(records[i].jsonl, {
        customRules: options.customRules,
        ruleset: options.ruleset,
        sanitizerPackageVersion: options.sanitizerPackageVersion,
        generatedAt: options.generatedAt,
      });
      // Same options + ruleset ⇒ the engine identity is identical across records.
      engine ??= result.engine;
    } catch (err) {
      if (err instanceof PublishRefusedError) {
        refusals.push({ sessionId: sessions[i].session.sessionId, blockingFindings: err.blockingFindings });
      } else {
        throw err;
      }
    }
  }
  if (refusals.length > 0) throw new BatchPublishRefusedError(refusals);
  // No refusals ⇒ every record passed ⇒ `engine` is set.
  const sharedEngine = engine as EngineInfo;

  const rawAlias = sessions[0].meta.contributorAlias;
  const alias = slugifyPathComponent(rawAlias);
  const targetBranch = options.targetBranch ?? 'main';
  // Deterministic branch: same SET (any order) → same hash → same branch.
  const hash8 = createHash('sha256').update([...ids].sort().join('\n'), 'utf-8').digest('hex').slice(0, 8);
  const branch = `contrib/${alias}/batch-${hash8}`;
  const prTitle = `Add ${sessions.length} sanitized sessions (${rawAlias})`;
  const now = options.now ?? new Date().toISOString();
  const license = options.license ?? sessions[0].meta.license ?? 'TBD (Open Question 2: CC-BY / ODC-BY)';

  const prBody = renderBatchPrBody({ sessions, records, engine: sharedEngine, now, license, alias: rawAlias });
  const commitMessage = renderBatchCommitMessage(sessions.length, rawAlias, sharedEngine);

  const stagedFiles = records.flatMap((r) => [r.recordPath, r.provenancePath]);
  const ghAvailable = await isGhAvailableAsync(options.asyncRunner ?? defaultAsyncRunner);
  const commands = [
    `git checkout -b ${branch}`,
    `git add ${stagedFiles.join(' ')}`,
    `git commit -m ${shellQuote(commitMessage.split('\n')[0])}`,
    `git push -u origin ${branch}`,
    `gh pr create --base ${targetBranch} --head ${branch} --title ${shellQuote(prTitle)} --body-file ${PR_BODY_FILE}`,
  ];

  return {
    records,
    branch,
    targetBranch,
    prTitle,
    prBody,
    commitMessage,
    engine: sharedEngine,
    recordCount: records.length,
    ghAvailable,
    stagedFiles,
    commands,
  };
}

/**
 * Stage a planned batch into the local clone: write every record + provenance
 * sidecar + the PR body file, then create the branch, `git add` all staged files,
 * and `git commit` — ONE commit for all N records. Does NOT push/open a PR
 * (`submitBatchContributionAsync` does). Requires `git`.
 */
export async function stageBatchContributionAsync(
  plan: BatchContributionPlan,
  options: ContributionOptions,
): Promise<BatchStageResult> {
  const runner = options.asyncRunner ?? defaultAsyncRunner;
  if (!(await isGitAvailableAsync(runner))) {
    throw new Error('git is not available; cannot stage the contribution locally');
  }
  const repo = options.targetRepo;

  const recordAbsolutePaths: string[] = [];
  for (const record of plan.records) {
    recordAbsolutePaths.push(writeRepoFile(repo, record.recordPath, record.fileContents));
    writeRepoFile(repo, record.provenancePath, `${JSON.stringify(record.provenance, null, 2)}\n`);
  }
  writeRepoFile(repo, PR_BODY_FILE, plan.prBody);

  const steps: Array<[string, string[]]> = [
    ['git', ['checkout', '-b', plan.branch]],
    ['git', ['add', ...plan.stagedFiles]],
    ['git', ['commit', '-m', plan.commitMessage]],
  ];
  let log = '';
  let committed = true;
  for (const [cmd, args] of steps) {
    const res = await runner.runAsync(cmd, args, { cwd: repo });
    log += `$ ${cmd} ${args.join(' ')}\n${res.stdout}${res.stderr}\n`;
    if (res.code !== 0) {
      committed = false;
      break;
    }
  }

  return { committed, branch: plan.branch, stagedFiles: plan.stagedFiles, recordAbsolutePaths, log };
}

/**
 * Push the batch branch once and open ONE PR via `gh`. Requires `gh`; throws when
 * absent so the daemon can surface the manual path. A non-zero push maps to
 * `opened:false` + `pushRejected:true` so the caller classifies `push_rejected`
 * distinctly from a failed PR open. Identical shape to `submitContributionAsync`.
 */
export async function submitBatchContributionAsync(
  plan: BatchContributionPlan,
  options: ContributionOptions,
): Promise<RunPrResult> {
  // MAINTENANCE: this push + `gh pr create` sequence hand-mirrors
  // `submitContributionAsync` in `pr.ts` (same gh gate, pushRejected classification,
  // and arg shape). If that function's command sequence changes, update this too.
  const runner = options.asyncRunner ?? defaultAsyncRunner;
  if (!(await isGhAvailableAsync(runner))) {
    throw new Error(
      'gh CLI not available; run the emitted commands manually (see plan.commands) to push + open the PR',
    );
  }
  const repo = options.targetRepo;
  const push = await runner.runAsync('git', ['push', '-u', 'origin', plan.branch], { cwd: repo });
  if (push.code !== 0) {
    return { opened: false, pushRejected: true, log: `push failed:\n${push.stderr}` };
  }
  const pr = await runner.runAsync(
    'gh',
    [
      'pr',
      'create',
      '--base',
      plan.targetBranch,
      '--head',
      plan.branch,
      '--title',
      plan.prTitle,
      '--body-file',
      join(repo, PR_BODY_FILE),
    ],
    { cwd: repo },
  );
  return { opened: pr.code === 0, log: `${push.stdout}${pr.stdout}${pr.stderr}` };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBatchCommitMessage(recordCount: number, alias: string, engine: EngineInfo): string {
  return [
    `Add ${recordCount} sanitized sessions (${alias})`,
    '',
    'Contributed via @mosga/publisher; mandatory local pre-check passed (0 blocking findings).',
    `records: ${recordCount}`,
    `ruleset: ${engine.rulesetVersion}`,
    `sanitizer: @mosga/sanitizer@${engine.sanitizerPackageVersion}`,
    `gitleaks: ${engine.gitleaksVersion}`,
  ].join('\n');
}

interface BatchPrBodyInput {
  sessions: SanitizedSession[];
  records: ExportedRecord[];
  engine: EngineInfo;
  now: string;
  license: string;
  alias: string;
}

function renderBatchPrBody(input: BatchPrBodyInput): string {
  // MAINTENANCE: the engine-stamp, attestation, and contributor-consent sections
  // below hand-mirror `renderPrBody` in `pr.ts` (kept verbatim rather than shared so
  // the single-session body stays byte-identical). If that function's attestation/
  // consent/engine-stamp wording changes, update the matching blocks here to keep
  // the batch and single PRs consistent.
  const { sessions, records, engine, now, license, alias } = input;
  const totalMessages = sessions.reduce((n, s) => n + s.messages.length, 0);
  const rows = records
    .map(
      (record, i) =>
        `| \`${sessions[i].session.sessionId}\` | ${sessions[i].messages.length} | \`${record.recordPath}\` |`,
    )
    .join('\n');
  return `## Sanitized sessions contribution (batch)

${records.length} sanitized AI coding sessions, contributed to the community dataset via \`@mosga/publisher\`.

| sessionId | messages | record path |
| --- | --- | --- |
${rows}
| **totals** | **${totalMessages}** | **${records.length} records** |

| field | value |
| --- | --- |
| records (sessions) | ${records.length} |
| contributor alias | \`${alias}\` |
| source CLI | \`${sessions[0].meta.sourceCli}\` |
| license | ${license} |

### Provenance / version stamp (pin this exact engine in CI)

| field | value |
| --- | --- |
| \`rulesetVersion\` (pre-check) | \`${engine.rulesetVersion}\` |
| \`sanitizerPackageVersion\` | \`${engine.sanitizerPackageVersion}\` |
| \`gitleaksVersion\` | \`${engine.gitleaksVersion}\` |

> CI MUST install \`@mosga/sanitizer@${engine.sanitizerPackageVersion}\` and re-scan these
> records. The local pre-check and the CI re-scan then run a byte-identical engine;
> a \`rulesetVersion\`/\`sanitizerPackageVersion\` mismatch is a visible failure, not a
> silent divergence.

### Sanitization attestation

- [x] Every session was scanned with the shared \`@mosga/sanitizer\` three-layer ruleset.
- [x] Every blocking finding (secrets, custom, redos-guard, ruleset-compile-error) was dispositioned; each gate was unlocked before export.
- [x] The MANDATORY local pre-check re-scanned each of these exact records and found **0 surviving blocking findings**.

### Contributor consent

- [x] I am contributing my own AI coding session data.
- [x] I understand this PR is public the instant it is created and its history is permanent.
- [x] I have reviewed the records and consent to their inclusion in the community dataset under the stated license.

_Prepared ${now} by @mosga/publisher._
`;
}
