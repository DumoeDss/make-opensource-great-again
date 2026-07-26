import { createHash } from 'node:crypto';

import { type SanitizedSession } from '@mosga/contracts';
import { type CompiledRuleset, compileRuleset } from '@mosga/sanitizer';

import DEFAULT_GITLEAKS_TOML from '../../sanitizer/vendor/gitleaks.toml?raw';
import {
  type ExportedRecord,
  deterministicProvenancePath,
  deterministicRecordPath,
  exportSession,
} from './export.js';
import {
  assertDataRepoPath,
  assertSupportedGitBranch,
  encodeRepoSegment,
} from './path-safety.js';
import { precheckRecord } from './precheck.js';
import { type EngineInfo } from './provenance.js';
import { sanitizerPackageVersion as defaultSanitizerPackageVersion } from './version.js';

/** The maximum number of records accepted by one publication bundle. */
export const CONTRIBUTION_BUNDLE_MAX_RECORDS = 500;

/** The exact-content and manifest hashing contract implemented by this module. */
export const CONTRIBUTION_BUNDLE_CONTRACT_VERSION = 1 as const;

/**
 * The default engine is compiled once from a build-time embedded TOML string.
 * Neither compilation nor any function in its call graph reads a ruleset file.
 */
const DEFAULT_COMPILED_RULESET = compileRuleset({
  tomlText: DEFAULT_GITLEAKS_TOML,
  generatedAt: '1970-01-01T00:00:00.000Z',
});

export interface ContributionBundleOptions {
  /** Trusted local custom rules used by the mandatory final-byte pre-check. */
  customRules?: unknown[];
  /** Pre-compiled shared ruleset. Injectable for deterministic tests. */
  ruleset?: CompiledRuleset;
  /** Installed sanitizer package version stamped into provenance and engine metadata. */
  sanitizerPackageVersion?: string;
  /** Gitleaks version stamped into each provenance sidecar. */
  gitleaksVersion?: string;
  /** Scan/report timestamp override. It is never rendered into bundle metadata. */
  generatedAt?: string;
  /** Dataset license rendered into the target-independent PR body. */
  license?: string;
}

export interface ContributionBundleFile {
  kind: 'record' | 'provenance';
  /** Raw session identifier, before path slugification. */
  sessionId: string;
  /** Repo-relative POSIX path. */
  path: string;
  /** Exact UTF-8 string the publication backend must write. */
  contents: string;
  /** UTF-8 byte length of `contents`. */
  bytes: number;
  /** Lowercase hexadecimal SHA-256 of the exact UTF-8 `contents`. */
  contentHash: string;
}

export interface ContributionBundleRecord {
  /** Raw session identifier. */
  sessionId: string;
  messages: number;
  recordPath: string;
  provenancePath: string;
}

export interface ContributionRefusal {
  sessionId: string;
  /** Blocking finding counts keyed by rule ID; keys are in ordinal order. */
  blockingByRule: Record<string, number>;
}

/**
 * Safe compiler-boundary refusal. It deliberately exposes aggregate rule
 * counts only: never findings, previews, raw values, record bytes, or paths.
 */
export class ContributionBundleRefusedError extends Error {
  readonly refusals: ContributionRefusal[];

  constructor(refusals: readonly ContributionRefusal[]) {
    const safeRefusals = refusals.map((refusal) => ({
      sessionId: refusal.sessionId,
      blockingByRule: { ...refusal.blockingByRule },
    }));
    super(
      `contribution bundle refused: mandatory pre-check found blocking findings in ` +
        `${safeRefusals.length} session(s) [${safeRefusals.map((r) => r.sessionId).join(', ')}]`,
    );
    this.name = 'ContributionBundleRefusedError';
    this.refusals = safeRefusals;
  }
}

export interface ContributionBundle {
  contractVersion: typeof CONTRIBUTION_BUNDLE_CONTRACT_VERSION;
  contributorAlias: string;
  records: ContributionBundleRecord[];
  files: ContributionBundleFile[];
  branch: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  recordCount: number;
  totalBytes: number;
  contentDigest: string;
  engine: EngineInfo;
}

export interface ContributionManifestEntry {
  path: string;
  bytes: number;
  contentHash: string;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Utf8(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * Compute contract-v1 aggregate identity. The property order in this projection
 * is part of the contract and must not be changed without a contract bump.
 */
export function computeContributionContentDigest(
  files: readonly ContributionManifestEntry[],
): string {
  const manifest = [...files]
    .sort((left, right) => ordinalCompare(left.path, right.path))
    .map(({ path, bytes, contentHash }) => ({ path, bytes, contentHash }));
  return sha256Utf8(JSON.stringify(manifest));
}

function validateAndOrderSessions(
  sessions: readonly SanitizedSession[],
): SanitizedSession[] {
  if (sessions.length === 0) {
    throw new Error('contribution bundle requires at least one session');
  }
  if (sessions.length > CONTRIBUTION_BUNDLE_MAX_RECORDS) {
    throw new Error(
      `contribution bundle accepts at most ${CONTRIBUTION_BUNDLE_MAX_RECORDS} sessions; ` +
        `received ${sessions.length}`,
    );
  }

  const ordered = [...sessions].sort((left, right) =>
    ordinalCompare(left.session.sessionId, right.session.sessionId),
  );

  const aliases = [...new Set(ordered.map((session) => session.meta.contributorAlias))].sort(
    ordinalCompare,
  );
  if (aliases.length !== 1) {
    throw new Error(
      `contribution bundle requires one exact contributorAlias; got ${aliases
        .map((alias) => JSON.stringify(alias))
        .join(', ')}`,
    );
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const previousId = ordered[index - 1].session.sessionId;
    const sessionId = ordered[index].session.sessionId;
    if (sessionId === previousId) {
      throw new Error(
        `contribution bundle has duplicate raw sessionId ${JSON.stringify(sessionId)}`,
      );
    }
  }

  const pathOwners = new Map<string, string>();
  for (const session of ordered) {
    const sessionId = session.session.sessionId;
    const paths = [
      deterministicRecordPath(session),
      deterministicProvenancePath(session),
    ];
    for (const path of paths) {
      const owner = pathOwners.get(path);
      if (owner !== undefined) {
        throw new Error(
          `contribution bundle derived path collision at ${JSON.stringify(path)} ` +
            `for sessionIds ${JSON.stringify(owner)} and ${JSON.stringify(sessionId)}`,
        );
      }
      pathOwners.set(path, sessionId);
    }
  }

  return ordered;
}

function aggregateByRule(ruleIds: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const ruleId of ruleIds) {
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => ordinalCompare(left, right)),
  );
}

function bundleFile(
  kind: ContributionBundleFile['kind'],
  sessionId: string,
  path: string,
  contents: string,
): ContributionBundleFile {
  assertDataRepoPath(path);
  return {
    kind,
    sessionId,
    path,
    contents,
    bytes: Buffer.byteLength(contents, 'utf8'),
    contentHash: sha256Utf8(contents),
  };
}

function renderCommitMessage(
  records: readonly ContributionBundleRecord[],
  contributorAlias: string,
  engine: EngineInfo,
): string {
  const recordCount = records.length;
  const subject =
    recordCount === 1
      ? `Add sanitized session ${records[0].sessionId} (${contributorAlias})`
      : `Add ${recordCount} sanitized sessions (${contributorAlias})`;
  return [
    subject,
    '',
    'Contributed via @mosga/publisher; mandatory final-byte pre-check passed (0 blocking findings).',
    `records: ${recordCount}`,
    `ruleset: ${engine.rulesetVersion}`,
    `sanitizer: @mosga/sanitizer@${engine.sanitizerPackageVersion}`,
    `gitleaks: ${engine.gitleaksVersion}`,
  ].join('\n');
}

interface PrBodyInput {
  records: readonly ExportedRecord[];
  engine: EngineInfo;
  contributorAlias: string;
  license: string;
}

function renderPrBody(input: PrBodyInput): string {
  const { records, engine, contributorAlias, license } = input;
  const plural = records.length === 1 ? 'session' : 'sessions';
  const inclusionPronoun = records.length === 1 ? 'its' : 'their';
  const rows = records
    .map(
      (record) =>
        `| \`${record.session.session.sessionId}\` | ${record.session.messages.length} | ` +
        `\`${record.session.meta.sourceCli}\` | \`${record.provenance.schemaVersion}\` | ` +
        `\`${record.provenance.sanitizationRulesetVersion}\` | \`${record.recordPath}\` |`,
    )
    .join('\n');
  const totalMessages = records.reduce(
    (total, record) => total + record.session.messages.length,
    0,
  );

  return `## Sanitized ${plural} contribution

${records.length} sanitized AI coding ${plural}, contributed to the community dataset via \`@mosga/publisher\`.

| sessionId | messages | source CLI | schema version | sanitization ruleset | record path |
| --- | ---: | --- | --- | --- | --- |
${rows}
| **totals** | **${totalMessages}** |  |  |  | **${records.length} records** |

| field | value |
| --- | --- |
| records (sessions) | ${records.length} |
| contributor alias | \`${contributorAlias}\` |
| license | ${license} |

### Provenance / version stamp

| field | value |
| --- | --- |
| \`rulesetVersion\` (pre-check) | \`${engine.rulesetVersion}\` |
| \`sanitizerPackageVersion\` | \`${engine.sanitizerPackageVersion}\` |
| \`gitleaksVersion\` | \`${engine.gitleaksVersion}\` |

> CI MUST install \`@mosga/sanitizer@${engine.sanitizerPackageVersion}\` and re-scan the exact
> record file bytes. A ruleset or sanitizer-package mismatch is a visible failure.

### Sanitization attestation

- [x] Every ${plural} was scanned with the shared \`@mosga/sanitizer\` three-layer ruleset.
- [x] Every blocking finding was dispositioned and the human gate was unlocked before export.
- [x] The MANDATORY local pre-check re-scanned every exact record file body, including its trailing newline, and found **0 surviving blocking findings**.

### Contributor consent

- [x] I am contributing my own AI coding session data.
- [x] I understand this PR is public the instant it is created and its history is permanent.
- [x] I have reviewed the ${plural} and consent to ${inclusionPronoun} inclusion in the community dataset under the stated license.

_Prepared deterministically by @mosga/publisher._
`;
}

/**
 * Compile 1–500 stamped sessions into one complete, deterministic, target-
 * independent bundle. The operation is synchronous and has no filesystem,
 * process, network, workspace, Git, or GitHub capability.
 */
export function compileContributionBundle(
  sessions: readonly SanitizedSession[],
  options: ContributionBundleOptions = {},
): ContributionBundle {
  const orderedSessions = validateAndOrderSessions(sessions);
  const ruleset =
    options.ruleset ??
    (options.customRules === undefined || options.customRules.length === 0
      ? DEFAULT_COMPILED_RULESET
      : compileRuleset({
          tomlText: DEFAULT_GITLEAKS_TOML,
          customRules: options.customRules,
          generatedAt: options.generatedAt,
        }));
  const sanitizerPackageVersion =
    options.sanitizerPackageVersion ?? defaultSanitizerPackageVersion;

  const exportedRecords = orderedSessions.map((session) =>
    exportSession(session, {
      sanitizerPackageVersion,
      gitleaksVersion: options.gitleaksVersion ?? ruleset.gitleaksVersion,
    }),
  );

  const refusals: ContributionRefusal[] = [];
  let sharedEngine: EngineInfo | undefined;
  for (const record of exportedRecords) {
    const precheck = precheckRecord(record.fileContents, {
      ruleset,
      sanitizerPackageVersion,
      generatedAt: options.generatedAt,
    });
    sharedEngine ??= precheck.engine;
    if (!precheck.ok) {
      refusals.push({
        sessionId: record.session.session.sessionId,
        blockingByRule: aggregateByRule(
          precheck.blockingFindings.map((finding) => finding.ruleId),
        ),
      });
    }
  }

  if (refusals.length > 0) {
    throw new ContributionBundleRefusedError(refusals);
  }

  const engine = sharedEngine as EngineInfo;
  const files = exportedRecords
    .flatMap((record) => [
      bundleFile(
        'record',
        record.session.session.sessionId,
        record.recordPath,
        record.fileContents,
      ),
      bundleFile(
        'provenance',
        record.session.session.sessionId,
        record.provenancePath,
        `${JSON.stringify(record.provenance, null, 2)}\n`,
      ),
    ])
    .sort((left, right) => ordinalCompare(left.path, right.path));
  const records = exportedRecords.map(
    (record): ContributionBundleRecord => ({
      sessionId: record.session.session.sessionId,
      messages: record.session.messages.length,
      recordPath: record.recordPath,
      provenancePath: record.provenancePath,
    }),
  );
  const recordCount = records.length;
  const contributorAlias = orderedSessions[0].meta.contributorAlias;
  const contentDigest = computeContributionContentDigest(files);
  const branchLeaf =
    recordCount === 1
      ? encodeRepoSegment(orderedSessions[0].session.sessionId, 'sessionId')
      : 'batch';
  const branch =
    `contrib/${encodeRepoSegment(contributorAlias, 'contributorAlias')}/${branchLeaf}-` +
    contentDigest.slice(0, 8);
  assertSupportedGitBranch(branch);
  const prTitle =
    recordCount === 1
      ? `Add sanitized session ${records[0].sessionId} (${contributorAlias})`
      : `Add ${recordCount} sanitized sessions (${contributorAlias})`;
  const license =
    options.license ??
    orderedSessions[0].meta.license ??
    'TBD (Open Question 2: CC-BY / ODC-BY)';

  return {
    contractVersion: CONTRIBUTION_BUNDLE_CONTRACT_VERSION,
    contributorAlias,
    records,
    files,
    branch,
    commitMessage: renderCommitMessage(records, contributorAlias, engine),
    prTitle,
    prBody: renderPrBody({ records: exportedRecords, engine, contributorAlias, license }),
    recordCount,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    contentDigest,
    engine,
  };
}
