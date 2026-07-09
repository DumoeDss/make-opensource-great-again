## Why

Slice 1 shipped the multi-select queue journey but parked N>1 exits on a transitional page (per-item downloads + disabled placeholder cards); slice 2 shipped the batch publish backend (`/api/publish/batch/plan|stage|submit`, one branch/one PR for N records). This slice closes the loop the user asked for — "④ 出口攒到最后统一批量出" — by replacing the placeholders with real batch exits: a batch 出口① wizard over the new routes, a batch 出口② direct-submit that loops the EXISTING per-review endpoints with an aggregate estimate and per-item content-bound consent, and a batch export. Design authority: `rasen/office-hours/session-picker-batch-journey.md` B4.

## What Changes

- **Batch exit page** (`BatchExitCards`, replaces `BatchExitSummary`): N>1 step ④ becomes the dual-exit layout mirroring the single `ExitCards` — 出口①「公开数据集（批量）」 as a preflight-driven state card opening the batch wizard; 出口②「API 直投（批量）」; a low-key 「导出全部脱敏文件」 secondary (per-item download + download-all, serialization byte-identical to the publisher's `fileContents`). N=1 keeps the existing `ExitCards`/`PublishWizard`/`SubmitPanel` untouched.
- **Batch publish wizard** (`BatchPublishWizard`): the three-step 预检 → PR 预览 → 提交 flow over `publishBatchPlan/Stage/Submit`. The preview shows the batch branch, per-record table (sessionId / messages / record path / bytes), `prBody` in a styled `<pre>`, and the compare link. A `precheck_refused` (422 `blockingBySession`) lists每个被拒会话的规则聚合计数 with a 「回到该会话②」 jump that switches the queue to that review, focuses the named rule's group, and (being signed) flows through the existing void guard. gh-free fallback mirrors the single wizard: staged locations + exact commands + compareUrl + per-command copy. Success marks the journey 已完成.
- **Batch direct submit** (`BatchSubmitPanel`): one provider/model/mode selection; 「估算全部」 sequentially calls the EXISTING per-review estimate endpoint and shows the aggregate (总 token/总成本/条数, per-item detail in a fold); ONE dual acknowledgment (ToS risk + full retention) gates the run; 「批量直投 N 条」 sequentially submits each review with its OWN consent record bound to that review's `contentHash` (the acknowledgment applies to the enumerated batch; each consent is still content-bound). Progress k/N, per-item receipt/failure list, per-item retry. Changing provider/model/mode invalidates all estimates. ZERO daemon change.
- **Client + types**: `publishBatchPlan/publishBatchStage/publishBatchSubmit` on `ApiClient` (result-union like the single publish methods); `PublishBatchPlan` (per-record metadata + totals), `blockingBySession` on `PublishError`.
- **ReviewView wiring**: N>1 step ④ renders `BatchExitCards` with the signed items' reviewIds/titles and an `onJumpToSession(reviewId, ruleId)` that sets the current item + rule focus + step ②.

## Capabilities

### New Capabilities

- `ui-batch-exits`: the N>1 batch exit page (dual batch exit cards + batch export), the batch publish wizard over the batch routes (per-session refusal attribution with jump-back, gh-free fallback, completion state), and the batch direct-submit flow (aggregate estimate, single acknowledgment gating per-item content-bound consents, sequential submission with per-item receipts and retry).

### Modified Capabilities

- `ui-session-queue`: the "Transitional batch exit summary" requirement is REMOVED — superseded by `ui-batch-exits` (its N=1 scenario, keeping the single-session dual exit cards, is restated there).

## Impact

- **Modified package**: `packages/ui/` only. ZERO daemon/publisher change; zero new dependencies.
- **New files**: `src/components/journey/{BatchExitCards,BatchPublishWizard,BatchSubmitPanel}.tsx`.
- **Edited files**: `api/types.ts` + `api/client.ts` (batch publish surface), `ReviewView.tsx` (batch exit wiring + jump-back), `__tests__/` (new BatchPublishWizard/BatchSubmitPanel/BatchExitCards tests; ReviewView batch-exit cases updated).
- **Deleted**: `src/components/journey/BatchExitSummary.tsx` (superseded).
- **Also picks up** slice-1 accepted-known M3 (download/409-branch assertions) since the download moves here.
- **Out of scope**: receipt persistence/history page (Later), zip export (Later), CLI batch (Later), any daemon change.
