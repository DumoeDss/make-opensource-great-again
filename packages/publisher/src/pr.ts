import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type SanitizedSession } from '@mosga/contracts';
import { type CompiledRuleset } from '@mosga/sanitizer';

import { type ExportedRecord, exportSession, slugifyPathComponent } from './export.js';
import { assertPrecheckClean } from './precheck.js';
import { type EngineInfo, type ProvenanceStamp } from './provenance.js';
import { type CommandRunner, defaultRunner, isGhAvailable, isGitAvailable } from './runner.js';

/** Working file (inside the clone, never committed) holding the rendered PR body. */
export const PR_BODY_FILE = '.mosga-pr-body.md';

export interface ContributionOptions {
  /** Path to a local working clone of the target data-repo (a dry-run temp in tests). */
  targetRepo: string;
  /** Base branch the PR targets. Defaults to `main`. */
  targetBranch?: string;
  /** Custom rules (Layer 2) from trusted local config. Passed to the pre-check. */
  customRules?: unknown[];
  /** Pre-compiled ruleset for the pre-check (injectable for tests). */
  ruleset?: CompiledRuleset;
  /** Override the installed sanitizer version stamped (defaults to resolution). */
  sanitizerPackageVersion?: string;
  /** Override the gitleaks pin stamped. */
  gitleaksVersion?: string;
  /** Override scan/report timestamp for deterministic tests. */
  generatedAt?: string;
  /** ISO date shown in the PR body / commit footer. Defaults to now. */
  now?: string;
  /** Dataset license label for the PR body (Open Question 2 placeholder). */
  license?: string;
  /** Command runner (git/gh). Injectable; defaults to real child processes. */
  runner?: CommandRunner;
}

/** A fully-planned contribution: everything needed to stage + open a PR, computed in memory. */
export interface ContributionPlan {
  /** The exported record (serialized bytes + provenance). */
  record: ExportedRecord;
  /** Deterministic contribution branch: `contrib/<alias>/<sessionId>`. */
  branch: string;
  /** Base branch the PR targets. */
  targetBranch: string;
  /** Repo-relative record path. */
  recordPath: string;
  /** Repo-relative provenance sidecar path. */
  provenancePath: string;
  /** Commit message (first line + body). */
  commitMessage: string;
  /** PR title. */
  prTitle: string;
  /** Rendered PR body (markdown). */
  prBody: string;
  /** The provenance/version stamp. */
  provenance: ProvenanceStamp;
  /** The engine identity the pre-check ran under (CI parity). */
  engine: EngineInfo;
  /** Number of sessions/records (always 1). */
  recordCount: number;
  /** Whether the `gh` CLI is available for an automated push + PR open. */
  ghAvailable: boolean;
  /** Repo-relative files that get committed. */
  stagedFiles: string[];
  /** The exact `git`/`gh` command sequence for the manual path (run inside `targetRepo`). */
  commands: string[];
}

/**
 * Plan a PR contribution for a stamped session. Runs the export and the
 * MANDATORY pre-check first: if the pre-check finds any surviving blocking
 * finding it throws `PublishRefusedError` and NOTHING is planned, written, or
 * staged. On a clean pass it computes the branch, deterministic file placement,
 * PR body, and the exact `git`/`gh` command sequence — all in memory, touching
 * no disk and running no git.
 */
export function planContribution(session: SanitizedSession, options: ContributionOptions): ContributionPlan {
  const runner = options.runner ?? defaultRunner;

  // 1. Export (serialize + provenance). Refuses an un-stamped session.
  const record = exportSession(session, {
    sanitizerPackageVersion: options.sanitizerPackageVersion,
    gitleaksVersion: options.gitleaksVersion,
  });

  // 2. Mandatory pre-check on the EXACT bytes about to be published. Throws
  //    PublishRefusedError on any blocking finding — no staging happens.
  const precheck = assertPrecheckClean(record.jsonl, {
    customRules: options.customRules,
    ruleset: options.ruleset,
    sanitizerPackageVersion: options.sanitizerPackageVersion,
    generatedAt: options.generatedAt,
  });

  const alias = slugifyPathComponent(session.meta.contributorAlias);
  const sessionId = slugifyPathComponent(session.session.sessionId);
  const branch = `contrib/${alias}/${sessionId}`;
  const targetBranch = options.targetBranch ?? 'main';

  const prTitle = `Add sanitized session ${session.session.sessionId} (${session.meta.contributorAlias})`;
  const now = options.now ?? new Date().toISOString();
  const prBody = renderPrBody({
    session,
    record,
    engine: precheck.engine,
    now,
    license: options.license ?? session.meta.license ?? 'TBD (Open Question 2: CC-BY / ODC-BY)',
  });
  const commitMessage = renderCommitMessage(session, record, precheck.engine);

  const stagedFiles = [record.recordPath, record.provenancePath];
  const commands = [
    `git checkout -b ${branch}`,
    `git add ${stagedFiles.join(' ')}`,
    `git commit -m ${shellQuote(commitMessage.split('\n')[0])}`,
    `git push -u origin ${branch}`,
    `gh pr create --base ${targetBranch} --head ${branch} --title ${shellQuote(prTitle)} --body-file ${PR_BODY_FILE}`,
  ];

  return {
    record,
    branch,
    targetBranch,
    recordPath: record.recordPath,
    provenancePath: record.provenancePath,
    commitMessage,
    prTitle,
    prBody,
    provenance: record.provenance,
    engine: precheck.engine,
    recordCount: record.recordCount,
    ghAvailable: isGhAvailable(runner),
    stagedFiles,
    commands,
  };
}

export interface StageResult {
  /** True when the commit succeeded. */
  committed: boolean;
  branch: string;
  stagedFiles: string[];
  /** Absolute path of the written record file. */
  recordAbsolutePath: string;
  /** Combined stdout/stderr from the git steps, for diagnostics. */
  log: string;
}

/**
 * Stage a planned contribution into the local working clone: write the record +
 * provenance sidecar + PR body file, then create the branch, `git add` the
 * record/sidecar, and `git commit`. It does NOT push and does NOT open a PR —
 * that is `submitContribution` (gh-gated). Requires `git`.
 */
export function stageContribution(plan: ContributionPlan, options: ContributionOptions): StageResult {
  const runner = options.runner ?? defaultRunner;
  if (!isGitAvailable(runner)) {
    throw new Error('git is not available; cannot stage the contribution locally');
  }
  const repo = options.targetRepo;

  // Write the record, the machine-readable provenance sidecar, and the PR body.
  const recordAbsolutePath = writeRepoFile(repo, plan.recordPath, plan.record.fileContents);
  writeRepoFile(repo, plan.provenancePath, `${JSON.stringify(plan.provenance, null, 2)}\n`);
  writeRepoFile(repo, PR_BODY_FILE, plan.prBody);

  const steps: Array<[string, string[]]> = [
    ['git', ['checkout', '-b', plan.branch]],
    ['git', ['add', ...plan.stagedFiles]],
    ['git', ['commit', '-m', plan.commitMessage]],
  ];
  let log = '';
  let committed = true;
  for (const [cmd, args] of steps) {
    const res = runner.run(cmd, args, { cwd: repo });
    log += `$ ${cmd} ${args.join(' ')}\n${res.stdout}${res.stderr}\n`;
    if (res.code !== 0) {
      committed = false;
      break;
    }
  }

  return { committed, branch: plan.branch, stagedFiles: plan.stagedFiles, recordAbsolutePath, log };
}

/**
 * Push the branch and open the PR via `gh` (auth handled by `gh`). Requires the
 * `gh` CLI; throws when absent so callers fall back to `plan.commands` + the
 * manual path. Never invoked by tests — no live external PR.
 */
export function submitContribution(plan: ContributionPlan, options: ContributionOptions): RunPrResult {
  const runner = options.runner ?? defaultRunner;
  if (!isGhAvailable(runner)) {
    throw new Error(
      'gh CLI not available; run the emitted commands manually (see plan.commands) to push + open the PR',
    );
  }
  const repo = options.targetRepo;
  const push = runner.run('git', ['push', '-u', 'origin', plan.branch], { cwd: repo });
  if (push.code !== 0) {
    return { opened: false, log: `push failed:\n${push.stderr}` };
  }
  const pr = runner.run(
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

export interface RunPrResult {
  opened: boolean;
  log: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCommitMessage(
  session: SanitizedSession,
  record: ExportedRecord,
  engine: EngineInfo,
): string {
  return [
    `Add sanitized session ${session.session.sessionId} (${session.meta.contributorAlias})`,
    '',
    'Contributed via @mosga/publisher; mandatory local pre-check passed (0 blocking findings).',
    `records: ${record.recordCount}`,
    `ruleset: ${engine.rulesetVersion}`,
    `sanitizer: @mosga/sanitizer@${engine.sanitizerPackageVersion}`,
    `gitleaks: ${engine.gitleaksVersion}`,
  ].join('\n');
}

interface PrBodyInput {
  session: SanitizedSession;
  record: ExportedRecord;
  engine: EngineInfo;
  now: string;
  license: string;
}

function renderPrBody(input: PrBodyInput): string {
  const { session, record, engine, now, license } = input;
  const messageCount = session.messages.length;
  return `## Sanitized session contribution

One sanitized AI coding session, contributed to the community dataset via \`@mosga/publisher\`.

| field | value |
| --- | --- |
| records (sessions) | ${record.recordCount} |
| messages | ${messageCount} |
| contributor alias | \`${session.meta.contributorAlias}\` |
| source CLI | \`${session.meta.sourceCli}\` |
| schema version | \`${record.provenance.schemaVersion}\` |
| license | ${license} |
| record path | \`${record.recordPath}\` |

### Provenance / version stamp (pin this exact engine in CI)

| field | value |
| --- | --- |
| \`sanitizationRulesetVersion\` | \`${record.provenance.sanitizationRulesetVersion}\` |
| \`rulesetVersion\` (pre-check) | \`${engine.rulesetVersion}\` |
| \`sanitizerPackageVersion\` | \`${engine.sanitizerPackageVersion}\` |
| \`gitleaksVersion\` | \`${engine.gitleaksVersion}\` |

> CI MUST install \`@mosga/sanitizer@${engine.sanitizerPackageVersion}\` and re-scan this
> record. The local pre-check and the CI re-scan then run a byte-identical engine;
> a \`rulesetVersion\`/\`sanitizerPackageVersion\` mismatch is a visible failure, not a
> silent divergence.

### Sanitization attestation

- [x] This session was scanned with the shared \`@mosga/sanitizer\` three-layer ruleset.
- [x] Every blocking finding (secrets, custom, redos-guard, ruleset-compile-error) was dispositioned; the gate was unlocked before export.
- [x] The MANDATORY local pre-check re-scanned these exact bytes and found **0 surviving blocking findings**.

### Contributor consent

- [x] I am contributing my own AI coding session data.
- [x] I understand this PR is public the instant it is created and its history is permanent.
- [x] I have reviewed the record and consent to its inclusion in the community dataset under the stated license.

_Prepared ${now} by @mosga/publisher._
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeRepoFile(repo: string, relativePath: string, contents: string): string {
  // relativePath uses posix separators (a git path); join maps to the platform.
  const abs = join(repo, ...relativePath.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf-8');
  return abs;
}

/** Single-quote a string for a POSIX shell (the manual commands are documentation). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
