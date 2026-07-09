# Design — mosga-v04-batch-exits-ui

Authority: `rasen/office-hours/session-picker-batch-journey.md` B4. This file pins the implementation decisions.

## Client surface (`api/types.ts` + `api/client.ts`)

- `PublishBatchRecord { sessionId; recordPath; provenancePath; recordBytes; contentHash; messages }`
- `PublishBatchPlan { branch; targetBranch; prTitle; prBody; commitMessage; recordCount; ghAvailable; stagedFiles; commands; engine; compareUrl; totalRecordBytes; records: PublishBatchRecord[] }` — mirror the daemon's `uiSafeBatchPlan` exactly.
- `PublishError` gains optional `blockingBySession?: Array<{ reviewId; sessionId; blockingByRule: Array<{ ruleId; count }> }>` and optional `reviewId` (gate/404 attribution).
- `publishBatchPlan(reviewIds)/publishBatchStage(reviewIds)/publishBatchSubmit(reviewIds)` → result-union like the single methods; batch submit result carries `recordCount` in the receipt.

## Components

- **`BatchExitCards.tsx`** (replaces `BatchExitSummary.tsx`, deleted): layout mirrors `ExitCards` (grid 2-col + secondary under a divider). Props: `client`, `items: Array<{ reviewId; sessionId; title }>` (signed items), `onPublished`, `onSubmittedAll`, `onJumpToSession(reviewId, ruleId)`. Uses `usePreflight` for the 出口① state card (same 就绪/需配置/缺依赖/gh未登录 mapping + guidance copy as single). 「导出全部脱敏文件」 + per-item download rows: `client.exportReview` per item, filename `<sessionId>.sanitized.jsonl`, body `JSON.stringify(session) + '\n'` (byte-identical to publisher `fileContents`); refused/failed export → inline per-item error, no file.
- **`BatchPublishWizard.tsx`**: structural copy of `PublishWizard` with batch types (do NOT try to genericize `PublishWizard` — its testids and single-session contract stay frozen; accept the parallel file). Differences: plan call takes reviewIds; preview adds the per-record table (`preview-records`, one row per record) + `totalRecordBytes`; `precheck_refused` view groups by session (`refused-session-<sessionId>`) each listing `blockingByRule` rows with 「回到该会话②」 (`jump-to-session-<reviewId>-<ruleId>`); receipt line includes 共 N 条记录. Same PLAN_TIMEOUT_MS/slow-retry/pending states, same ManualFallback shape (reuse via copy; keep per-command copy buttons).
- **`BatchSubmitPanel.tsx`**: provider/model/mode selects (same options/copy as `SubmitPanel`), 「估算全部」 sequentially calls `estimateSubmit` per item (progress text; abort on target change), aggregate box (`batch-estimate`: 总 token / 总成本 ~$ / N 条) + `AdvancedFold` per-item table; the SAME dual-ack checkboxes copy as `SubmitPanel` (reworded to name the batch: 「以下 N 个会话」); 「批量直投 N 条」 runs sequentially — per item `client.submit(reviewId, { providerId, model, replayMode, consent })` where consent = `{ consentVersion: '0.2.0', both acks, target, model, replayMode, estimatedTokens: item.totalTokens, contentHash: item.contentHash, confirmedAt: now }`; progress k/N; results list (`batch-submit-result-<sessionId>`: receipt summary or error + 「重试」). Failures don't stop the loop. `onSubmittedAll` fires when every item has a successful receipt (completion state). Estimates invalidate on any target change (same `invalidate()` pattern).
- **`ReviewView.tsx`**: N>1 step ④ renders `BatchExitCards` (replacing the summary); `onJumpToSession(reviewId, ruleId)` = find item index → `setCurrent(idx)`; `setFocusRuleId(ruleId)`; `setActiveStep(2)` (existing `selectItem` reset semantics apply — call the reset then set focus); completion: `onPublished` OR `onSubmittedAll` → `setCompleted(true)`.

## Decisions

- **出口② stays on the per-review endpoints** — a batch daemon submit route would buy nothing (each submission is an independent provider call with its own consent) and would centralize consent, which we explicitly avoid: consent is per content hash.
- **One acknowledgment for the enumerated batch is acceptable** because the ack text names the batch size and每条 consent record remains content-bound (hash + estimatedTokens per item); this mirrors the single flow's informed-consent semantics without asking the user to re-check N times.
- **Journey 已完成 (batch)**: EITHER exit completes the journey (same as single). For 出口②, completion requires ALL items successfully submitted (partial success keeps ④ active with retry affordances).
- **Sequential, never parallel** loops (estimates, submits, downloads): the daemon is a single local process and 出口② hits external providers — sequential keeps progress honest and avoids provider rate bursts.
- **`PublishWizard`/`SubmitPanel`/`ExitCards` are NOT modified** — N=1 contract frozen; batch components are parallel files. Shared cosmetic helpers may be extracted ONLY if zero-risk (prefer duplication).

## Key testids

`batch-exit-cards`, `batch-exit-one`, `batch-exit-two`, `batch-export-all`, `batch-download-<sessionId>`, `batch-publish-wizard`, `preview-records`, `refused-session-<sessionId>`, `jump-to-session-<reviewId>-<ruleId>`, `batch-manual-fallback`, `batch-submit-panel`, `batch-estimate`, `batch-estimate-all`, `batch-submit-run`, `batch-submit-result-<sessionId>`, `batch-submit-retry-<sessionId>`.

## Test plan

- `BatchPublishWizard.test.tsx` (fake client): plan → preview table rows; `blockingBySession` → per-session refusal + jump callback args; ghReady one-click success → published badge + `onPublished`; gh-free stage → manual fallback commands; `branch_exists`/`publish_in_flight` error text.
- `BatchSubmitPanel.test.tsx`: estimate-all sums + count; target change invalidates; run submits sequentially with per-item consent (assert each call's `contentHash` matches that item's estimate); mid-item failure → later items still submitted + retry shown + `onSubmittedAll` NOT fired; retry success → `onSubmittedAll` fires.
- `BatchExitCards.test.tsx`: preflight states drive 出口① card; export-all downloads per item and surfaces a 409/failure inline (covers slice-1 M3 gap).
- `ReviewView.test.tsx`: N>1 ④ renders batch-exit-cards; jump-to-session switches current + focuses rule at ②; batch publish/submit completion → 已完成 badge.
