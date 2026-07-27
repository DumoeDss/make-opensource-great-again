## Context

The approved office-hours design makes `@mosga/publisher` the content boundary beneath a later `GitHubPublication` module. Today that boundary does not exist:

- `ContributionOptions` requires `targetRepo` even when merely planning.
- `planContribution*` probes `gh` and returns `ghAvailable` plus shell commands.
- `stageContribution*` and `submitContribution*` write into a caller-selected clone and execute Git/`gh`.
- `batch.ts` duplicates rendering and delivery, while N=1 delegates to the separate single planner.
- The final file body is `record.fileContents` (JSONL plus trailing newline), but planning currently passes `record.jsonl` (without that newline) to the mandatory pre-check.
- Batch branch identity is based only on session IDs, so changed content can reuse the same branch.

The parent change is a hard replacement: no compatibility adapter, deprecation surface, or parallel legacy publication path. This child is limited to pure publisher compilation. The next child will consume the contract defined here and implement target resolution, sealed previews, managed workspaces, Git/GitHub delivery, and receipts.

Existing `dataset-export` and `publish-precheck` behavior remains foundational: only stamped sessions may be exported; record files stay one JSONL record per session; metadata normalization and provenance sidecars remain; and the shared sanitizer plus raw-byte backstop must refuse every surviving blocking finding.

## Goals / Non-Goals

**Goals:**

- Expose one synchronous, side-effect-free compiler for 1–500 stamped sessions.
- Return all exact UTF-8 file contents and all target-independent metadata needed by the publication backend.
- Preserve the mandatory final-byte pre-check and aggregate refusals without producing a partial bundle.
- Make the entire result deterministic for the same logical session set and compiler options, independent of input order.
- Bind the branch and downstream sealed preview to the exact contribution file set through per-file hashes and one canonical digest.
- Remove local clone, Git, `gh`, target branch, manual command, and delivery concerns from the publisher public surface.

**Non-Goals:**

- No target configuration, repository compatibility check, GitHub account/permission/fork resolution, or GitHub API.
- No managed cache/worktree, branch collision recovery, commit, push, pull request, journal, preview store, or receipt.
- No daemon HTTP route, review lookup/gate orchestration, target revision sealing, or UI work.
- No migration or compatibility wrapper for the old single/batch plan-stage-submit APIs.
- No change to the dataset record schema, message-body slicing, sanitizer rules, or provenance format.
- No automated test may write to a real external repository.

## Decisions

### D1 — One pure compiler is the only publisher planning entry point

Add a target-independent module (for example `src/contribution.ts`) exporting:

```ts
interface ContributionBundleOptions {
  customRules?: unknown[];
  ruleset?: CompiledRuleset;
  sanitizerPackageVersion?: string;
  gitleaksVersion?: string;
  generatedAt?: string;
  license?: string;
}

interface ContributionBundleFile {
  kind: 'record' | 'provenance';
  sessionId: string;
  path: string;
  contents: string;
  bytes: number;
  contentHash: string;
}

interface ContributionBundleRecord {
  sessionId: string;
  messages: number;
  recordPath: string;
  provenancePath: string;
}

interface ContributionBundle {
  contractVersion: 1;
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

function compileContributionBundle(
  sessions: readonly SanitizedSession[],
  options?: ContributionBundleOptions,
): ContributionBundle;
```

`contents` is the exact string to write using UTF-8; `bytes` is `Buffer.byteLength(contents, 'utf8')`. The bundle contains only repo-relative POSIX paths. It contains no target repo/path, upstream, base branch, remote, runner, commands, availability probe, or external-state result.

The compiler is synchronous because export, serialization, hashing, rendering, and pre-check are in-memory CPU work. Making it async after removing subprocesses would obscure its purity without adding concurrency. The publication backend may call it from an async preview flow.

Alternative: keep `planContribution` and `planBatchContributionAsync` as wrappers. Rejected because the approved hard replacement forbids a dual public model and wrappers would preserve two semantics for N=1.

### D2 — N=1 and N>1 share validation, compilation, and output

The compiler accepts 1–500 sessions. It rejects:

- an empty or oversized input;
- differing exact `contributorAlias` values;
- duplicate raw session IDs; and
- any duplicate derived repo-relative file path, including collisions caused by slugification of distinct IDs.

After validation, sessions are sorted by raw `sessionId` using a locale-independent ordinal comparison. Records are exported in that order; files are finally sorted by repo-relative path. PR rows, record summaries, staged file identity, hashes, and the digest therefore do not depend on request ordering.

There is no single-session delegation. N=1 changes only human-facing wording and uses `contrib/<alias>/<sessionId>-<digest8>`; N>1 uses `contrib/<alias>/batch-<digest8>`. Both shapes, safety checks, hashing, and downstream consumption are otherwise identical.

Alternative: preserve request order while hashing a sorted ID list. Rejected because it produces the same branch with different PR bodies/file arrays and therefore is not a deterministic bundle.

### D3 — Pre-check the literal record file bodies and aggregate safe refusal data

For every exported record, the compiler calls the mandatory pre-check with `record.fileContents`, not `record.jsonl`. This includes the exact trailing newline written to the dataset file. Every record is checked even after one fails; only after the pass completes does the compiler either return the complete bundle or throw one typed `ContributionBundleRefusedError`.

The bundle refusal exposes:

```ts
interface ContributionRefusal {
  sessionId: string;
  blockingByRule: Record<string, number>;
}
```

Keys and entries are deterministically sorted. It carries aggregate counts only—not match previews, raw matched values, record contents, local paths, or subprocess text—so the backend can map session IDs to review IDs and safely implement the parent HTTP contract. Existing low-level pre-check APIs may retain their internal `Finding[]` diagnostic type, but the contribution compiler boundary does not leak it.

If any export, validation, or pre-check fails, no `ContributionBundle` is returned. Because compilation has no filesystem, process, or network capability, refusal also guarantees no workspace or GitHub write side effect.

Alternative: fail fast. Rejected because batch callers need all refused sessions in one review cycle and the current batch contract already promises aggregation.

### D4 — Hash exact UTF-8 bytes and commit to a canonical file manifest

For every file:

```text
contentHash = lowercase hex SHA-256(UTF-8(contents))
bytes       = UTF-8 byte length(contents)
```

The aggregate digest is:

```text
contentDigest = lowercase hex SHA-256(
  UTF-8(JSON.stringify(
    files sorted by path, projected in property order to
    [{ path, bytes, contentHash }, ...]
  ))
)
```

This versioned v1 algorithm binds every repo-relative path and exact file body without relying on platform path separators or default encodings. `contractVersion: 1` lets the downstream sealed-preview store reject an unknown hashing contract instead of silently recomputing a different identity.

The first eight hexadecimal characters of `contentDigest` suffix the branch. The full digest is returned for preview sealing and submit-time comparison.

Alternative: hash only sorted session IDs. Rejected because a disposition/content change can keep the same branch and defeats the branch-conflict/idempotency rules in the parent design.

Alternative: include PR title/body or commit message in `contentDigest`. Rejected because the parent contract defines it as the exact contribution content digest; those strings are separately sealed by the backend and are not dataset files.

### D5 — PR/commit metadata is deterministic and target-independent

The compiler renders the existing provenance, attestation, consent, record-count, and per-session summary information from canonical records. It removes the wall-clock “Prepared at” value (or derives any required timestamp solely from explicit options) so repeated compilation does not change output. Batch metadata does not assume every record has the first session's `sourceCli` or provenance; shared facts are shown once and per-record differences remain represented by each provenance sidecar.

`branch`, `commitMessage`, `prTitle`, and `prBody` contain no target branch, upstream/push repository, local path, remote name, command, or `gh` availability. The backend combines these values with its resolved target when constructing a preview and explicit GitHub request.

Alternative: let the backend render all PR metadata. Rejected because record/provenance attestation belongs with the publisher format and keeping it in the bundle prevents single/batch copy-paste drift.

### D6 — Delivery APIs and their supporting public surface are deleted

Remove the public single/batch plan types and functions, stage/submit result types and functions, `PR_BODY_FILE`, `writeRepoFile`, `shellQuote`, and command-runner exports that exist only for publisher-owned Git/`gh` delivery. `runner.ts` is not used by the pure compiler; any subprocess seam needed by the later publication backend is owned behind that backend's semantic adapters.

Update the publisher CLI and package metadata so they no longer advertise or accept a target repo, `prepare`, or `--stage`. A low-level standalone pre-check command may remain, but no CLI path may restore local-clone staging or manual Git/`gh` instructions.

Alternative: leave the old exports unused until the backend lands. Rejected because this portfolio runs serially on one branch and the approved final state explicitly forbids a legacy route.

### D7 — The backend consumes bundle bytes; it does not reconstruct them

The downstream publication backend receives the compiler result as an opaque, versioned content contract:

- preview metadata is derived from `records`, `files`, `totalBytes`, `contentDigest`, PR fields, and `engine`;
- the sealed preview retains the exact `files[].contents` privately;
- submit re-obtains the current stamped sessions, recompiles with the same explicit compiler options, and compares `contentDigest`;
- the managed workspace writes each `contents` as UTF-8, then verifies `bytes` and `contentHash` before `git add`;
- the backend supplies upstream, base/head, target revision, workspace, and GitHub semantics separately.

The backend must not call `exportSession` and recreate file order, sidecars, PR metadata, or hashes itself. That would create two content authorities and weaken preview/submit consistency.

## Risks / Trade-offs

- **[Breaking child temporarily leaves daemon imports uncompilable]** → The parent portfolio sequences publication-backend immediately after this child on the same branch; this child still updates publisher-local tests, while portfolio-level typecheck/build is run after dependent code migrates.
- **[Ordinal sorting changes current batch PR row order]** → The stable order is intentional and specified; UI request order is not content identity.
- **[Hash-manifest algorithm could evolve]** → `contractVersion` is explicit and covered by fixed vectors; unknown versions fail closed.
- **[Aggregated errors contain less diagnostic detail]** → Low-level pre-check APIs retain internal diagnostics, while the cross-module compiler interface deliberately exposes only rule counts required by the safe HTTP contract.
- **[500 records may make an in-memory bundle large]** → The existing product limit bounds memory, compilation remains linear in total bytes, and a sealed preview already needs the exact bytes for safe submit.
- **[Provenance sidecars are not independently parsed by `precheckRecord`]** → Their variable values are derived from the already scanned record or trusted compiler engine options; all sidecar bytes are nevertheless hashed and sealed. A future sidecar format accepting untrusted free text must add a raw-byte scan before raising the contract version.

## Migration Plan

1. Add the bundle types, refusal type, compiler, canonical hash helper, and deterministic renderers with tests.
2. Replace publisher exports and publisher-internal CLI/tests with the new pure surface; remove single/batch delivery code and target/runner dependencies.
3. Verify publisher typecheck/tests and Rasen artifact validation. Repository-wide build may remain red only at known daemon imports until the dependent publication-backend child migrates them.
4. The publication-backend child imports `compileContributionBundle` and `ContributionBundle`, implements sealed preview/workspace/GitHub semantics, and deletes the old daemon routes/imports.

Rollback within the unshipped portfolio is a commit revert. There is no data migration and this child performs no external state change.

## Open Questions

None within this child. The official target repository, dataset license, final `.mosga-dataset.json` contract, and GitHub login UX remain parent-level pre-launch decisions; the compiler accepts an explicit license string and is otherwise target-agnostic.
