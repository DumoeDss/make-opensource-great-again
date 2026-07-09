# Tasks — mosga-v04-batch-publish-core

Ordered, individually completable. Backend-only (`packages/publisher` + `packages/daemon`); ZERO UI change; NO new real-git tests (inject fake async runners). Capability: `publish-batch` (new). Design authority: `rasen/office-hours/session-picker-batch-journey.md` B3 + this change's `design.md`. Do NOT touch archived artifacts or `rasen/changes/codex-session-reader/`.

## 1. Publisher batch module

- [x] 1.1 Export `writeRepoFile` and `shellQuote` from `packages/publisher/src/pr.ts` (additive; no behaviour change; pr.test.ts/template.test.ts untouched and green).
- [x] 1.2 Create `packages/publisher/src/batch.ts`: `BatchContributionPlan`, `BatchPublishRefusedError` (per-session `refusals`), `planBatchContributionAsync` per design.md (empty/alias-mismatch/duplicate-id refusals; per-session export + `assertPrecheckClean` with aggregation; N=1 delegates to `planContributionAsync`; N>1 `contrib/<alias>/batch-<hash8>` + batch title/commit/body table + single-sequence `commands`).
- [x] 1.3 Add `stageBatchContributionAsync` (N record+sidecar writes + PR body, one checkout/add/commit through the async runner) and `submitBatchContributionAsync` (one push + one `gh pr create`; `pushRejected` distinguished) to `batch.ts`.
- [x] 1.4 Export the batch surface from `packages/publisher/src/index.ts`.
- [x] 1.5 Add `packages/publisher/src/__tests__/batch.test.ts` per design.md test plan (determinism, degradation, refusal aggregation, alias/duplicate errors, stage/submit command sequences via recording fake runner + temp dir).

## 2. Daemon batch routes

- [x] 2.1 In `packages/daemon/src/publish.ts`, add the zod body schema (`reviewIds` 1–20), dedupe + sorted `batchKey`, `stampedBatch` (per-review 404/GATE_LOCKED with `reviewId` attribution), and extract the rule-aggregation fold shared with the single `precheck_refused` mapping.
- [x] 2.2 Add `POST /api/publish/batch/plan`: dataRepo → per-review stamped → git → batch plan (`BatchPublishRefusedError` → 422 `blockingBySession`) → `uiSafeBatchPlan` + `compareUrl` (read-only, not mutexed).
- [x] 2.3 Add `POST /api/publish/batch/stage` + `runBatchStage` (shared `publishInFlight` mutex; check order mutex → dataRepo → git → gates → repoClean → plan → batch-branch collision residue guidance → stage; success sets the `batchKey` stage flag and returns `{ staged, branch, stagedFiles, recordCount }`).
- [x] 2.4 Add `POST /api/publish/batch/submit`: stage-if-not-staged by `batchKey`, `gh_unauthenticated` gate, `submitBatchContributionAsync`, `push_rejected`/`submit_failed` mapping, success receipt with `recordCount` + derived `compareUrl`.
- [x] 2.5 Add `packages/daemon/src/__tests__/publish-batch.test.ts` per design.md test plan (mirror `publish.test.ts` harness; includes mutex-shared-with-single and size-bound cases).

## 3. Verification

- [x] 3.1 From the repo root: `npm run typecheck` + `npm run build` + `npx vitest run --testTimeout=20000` all green (219+slice-1 baseline preserved, new tests added); `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v04-batch-publish-core --strict` passes.
