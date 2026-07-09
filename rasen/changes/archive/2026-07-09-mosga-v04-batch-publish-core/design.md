# Design — mosga-v04-batch-publish-core

Authority: `rasen/office-hours/session-picker-batch-journey.md` B3. This file pins the implementation decisions.

## Publisher (`packages/publisher/src/batch.ts`, new file)

- **Types**:
  - `BatchContributionPlan { records: ExportedRecord[]; branch; targetBranch; prTitle; prBody; commitMessage; engine: EngineInfo; recordCount: number; ghAvailable: boolean; stagedFiles: string[]; commands: string[] }` — per-record provenance lives on each `ExportedRecord`; `engine` is the shared pre-check identity (asserted identical across records — same options ⇒ same engine).
  - `BatchPublishRefusedError extends Error { refusals: Array<{ sessionId: string; blockingFindings: PrecheckFinding[] }> }` (whatever finding type `PublishRefusedError` carries — mirror it).
  - `BatchContributionOptions` = reuse `ContributionOptions` (targetRepo/targetBranch/ruleset/versions/now/license/asyncRunner).
- **`planBatchContributionAsync(sessions, options)`**:
  1. Refuse an empty array; refuse alias mismatch (compare `meta.contributorAlias` across sessions, error names the differing values).
  2. `exportSession` each; run the pre-check per record collecting refusals (catch per-session `PublishRefusedError`, aggregate; throw `BatchPublishRefusedError` if any). Reuse `assertPrecheckClean` directly (same as `buildPlan` does).
  3. Duplicate sessionIds in one batch → config error (two same-id records would collide on `recordPath`).
  4. N=1: delegate to `planContributionAsync(sessions[0], options)` and wrap into the batch shape (records=[record], same branch/title/body/commands) — byte-identical degradation.
  5. N>1: `branch = contrib/<alias>/batch-<hash8>`, `hash8 = sha256(sortedSessionIds.join('\n')).slice(0,8)`. `prTitle = Add ${N} sanitized sessions (${alias})`. Commit message mirrors the single one with `records: ${N}`.
  6. Batch PR body: same skeleton as the single body (attestation/consent/engine-stamp sections verbatim) but the top table is per-session rows `| sessionId | messages | record path |` plus a totals line. Extract the shared sections into small render helpers if duplication hurts; do NOT change the single-session body output (template.test.ts must stay green).
  7. `commands`: `git checkout -b <branch>`, ONE `git add <all staged files>`, one commit, one push, one `gh pr create` (same shape as single, `--body-file .mosga-pr-body.md`).
- **`stageBatchContributionAsync(plan, options)`**: mirror `stageContributionAsync` — write every record+sidecar (`writeRepoFile`) + PR body once, then checkout/add/commit once. Reuse `pr.ts`'s private helpers by EXPORTING `writeRepoFile` + `shellQuote` from `pr.ts` (additive export, no behaviour change) rather than duplicating.
- **`submitBatchContributionAsync(plan, options)`**: identical body to `submitContributionAsync` except it takes the batch plan type — extract a shared `pushAndOpenPr(branch, targetBranch, prTitle, repo, runner)` helper used by both, or accept the small duplication; do not change the single function's observable behaviour.
- **Index exports**: add batch types/functions + `BatchPublishRefusedError` to `packages/publisher/src/index.ts`.

## Daemon (`packages/daemon/src/publish.ts` extended)

- Batch routes live in the SAME `createPublishRoutes` closure (they need `stageState`/`publishInFlight`/helpers). Route patterns: `POST /api/publish/batch/plan|stage|submit` (static segments — no param conflicts with `/api/publish/preflight`).
- Body validation: zod `{ reviewIds: z.array(z.string()).min(1).max(20) }` → dedupe preserving order → `sorted = [...deduped].sort()`; `batchKey = sorted.join(',')` for stage state (store in the existing `Map` — keys can't collide with reviewIds since they contain `,` only for N>1; for N=1 the batch key IS the reviewId, which intentionally SHARES stage state with the per-review route — same branch, same residue semantics).
- `stampedBatch(reviewIds)`: per review, reuse `stampedSessionFor` — first failure returns immediately with `reviewId` merged into the error json (`{ ...result.json, reviewId }`).
- `computeBatchPlan(sessions)`: `planBatchContributionAsync` → catch `BatchPublishRefusedError` → 422 `precheck_refused` + `blockingBySession: refusals.map(r => ({ reviewId: byS session lookup, sessionId, blockingByRule: aggregate(r.blockingFindings) }))` — reuse the existing rule-aggregation logic (extract the small fold into a helper shared with the single route).
- Check order per stage (mirror single): mutex → dataRepo → git → per-review gate → repoClean → batch plan/precheck → branch collision (batch branch, keyed residue rules identical) → stage. Submit: stage-if-not-staged by `batchKey` flag, then `ghAuthenticatedAsync` → `submitBatchContributionAsync` → push_rejected / submit_failed / success receipt `{ opened, branch, receipt: { branch, targetBranch, prTitle, compareUrl, submittedAt, recordCount } }`.
- `uiSafeBatchPlan`: `{ branch, targetBranch, prTitle, prBody, commitMessage, recordCount, ghAvailable, stagedFiles, commands, engine, compareUrl, totalRecordBytes, records: [{ sessionId, recordPath, provenancePath, recordBytes, contentHash, messages }] }` — per-record `contentHash` = sha256 of that record's `fileContents` (same recipe as the single plan), `messages` = `record.session.messages.length`.

## Test plan

- `packages/publisher/src/__tests__/batch.test.ts` (fixtures from `_fixtures.ts`): determinism (same set any order → same branch), N=1 degradation equals `planContributionAsync` output, alias mismatch throws, duplicate sessionId throws, refusal aggregation names all refused sessions, batch body table rows + totals, stage against a temp dir with a recording fake runner (files written, one commit sequence), submit push-rejected vs opened.
- `packages/daemon/src/__tests__/publish-batch.test.ts` (mirror `publish.test.ts` harness: fake `AsyncCommandRunner`, temp `dataRepoPath`): happy plan/stage/submit, GATE_LOCKED names the review, unknown review 404 names it, refusal 422 `blockingBySession`, size-0/21 rejected 400, mutex shared with the single route (in-flight single blocks batch and vice versa), `branch_exists` residue on batch branch, plan excludes record bytes.
- NO new real-git tests. Single-session tests must pass untouched.
