# Tasks — mosga-v04-batch-exits-ui

Ordered, individually completable. Pure `packages/ui` change; ZERO daemon/publisher change; zero new dependencies. Capability: `ui-batch-exits` (new) + `ui-session-queue` (removed transitional requirement). Design authority: `rasen/office-hours/session-picker-batch-journey.md` B4 + this change's `design.md`. `PublishWizard`/`SubmitPanel`/`ExitCards` are frozen (N=1 contract) — batch components are parallel files. Do NOT touch archived artifacts, `rasen/changes/codex-session-reader/`, or `rasen/changes/settings-provider-management/`.

## 1. Client surface

- [x] 1.1 Add `PublishBatchRecord`/`PublishBatchPlan` and `PublishError.blockingBySession`/`reviewId` to `api/types.ts` (mirror the daemon's `uiSafeBatchPlan` + batch error bodies exactly).
- [x] 1.2 Add `publishBatchPlan/publishBatchStage/publishBatchSubmit(reviewIds)` to `ApiClient` + `apiClient` (result-union pattern of the single publish methods); extend test fake clients' stubs.

## 2. Batch exit page

- [x] 2.1 Create `src/components/journey/BatchExitCards.tsx` per design.md (dual cards + `usePreflight` state card for 出口①, secondary 「导出全部脱敏文件」 + per-item downloads with inline errors, serialization `JSON.stringify(session) + '\n'`); delete `BatchExitSummary.tsx`.
- [x] 2.2 Wire `ReviewView.tsx`: N>1 step ④ → `BatchExitCards`; `onJumpToSession(reviewId, ruleId)` (selectItem reset + rule focus + step ②); journey completion from `onPublished`/`onSubmittedAll`.

## 3. Batch publish wizard (出口①)

- [x] 3.1 Create `src/components/journey/BatchPublishWizard.tsx` per design.md: 预检 (batch plan, pending/slow states) → PR 预览 (batch branch, `preview-records` table, totals, prBody `<pre>`, compare link) → 提交 (ghReady one-click / gh-free stage + `batch-manual-fallback` commands + copy). `blockingBySession` → per-session refusal groups with 「回到该会话②」 jumps. Success receipt includes record count and fires `onPublished`.

## 4. Batch direct submit (出口②)

- [x] 4.1 Create `src/components/journey/BatchSubmitPanel.tsx` per design.md: single target selection; sequential 「估算全部」 with aggregate box + per-item fold; batch-named dual acks; sequential 「批量直投 N 条」 with per-item content-bound consent, progress, per-item results + retry; failures don't stop the loop; `onSubmittedAll` only when every item has a receipt; target change invalidates.

## 5. Tests + verification

- [x] 5.1 Add `BatchPublishWizard.test.tsx`, `BatchSubmitPanel.test.tsx`, `BatchExitCards.test.tsx` per design.md test plan (the export-all failure case covers slice-1 M3).
- [x] 5.2 Update `ReviewView.test.tsx` batch-exit cases (batch cards render, jump-to-session, completion) — replace the placeholder assertions.
- [x] 5.3 From the repo root: `npm run typecheck` + `npm run build` + `npx vitest run packages/ui packages/daemon packages/publisher --testTimeout=20000` green; `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v04-batch-exits-ui --strict` passes.
