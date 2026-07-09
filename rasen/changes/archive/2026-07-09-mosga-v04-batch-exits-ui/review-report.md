# 评审报告 — mosga-v04-batch-exits-ui（对抗性评审）

评审对象：工作树未提交改动——新增 `journey/{BatchExitCards,BatchPublishWizard,BatchSubmitPanel}.tsx` + 三个测试，修改 `ReviewView.tsx`/`ReviewView.test.tsx`，删除 `BatchExitSummary.tsx`。`api/types.ts`/`api/client.ts` 的批量表面**已在先前提交落地**（`git diff HEAD` 为空），本次按「已提交依赖表面」审其内容正确性（见轴 6/7）。

验证结果：`npm run typecheck` ✅ / `npm run build` ✅ / `npx vitest run packages/ui packages/daemon packages/publisher` **229 passed, 1 skipped（37 文件）** ✅ / `rasen validate mosga-v04-batch-exits-ui --strict` ✅。

---

## 逐轴结论

1. **规格符合性**：`ui-batch-exits` 3 需求 11 场景**全部**有实现 + 测试（对照表见下）。`ui-session-queue` 的 REMOVED delta 标题「Transitional batch exit summary」与切片 1 归档主 spec **逐字一致**，rasen strict 通过 ⇒ 归档安全。
2. **N=1 冻结契约**：`PublishWizard.tsx`/`PublishWizard.test.tsx`/`ExitCards.tsx`/`SubmitPanel.tsx` **均未改动**（`git diff HEAD` 为空）；N=1 仍走 `ExitCards`。批量 testid 全部 `batch-` 前缀，与单组件（`submit-panel`/`submit-estimate`/`publish-wizard`…）**零碰撞**。
3. **安全轴（重点）**：出口② 每条 consent 绑**各自** `contentHash`——`submitItem(item, est)` 用传入的该项 est，`onRunAll`/`onRetry` 均取 `estimates[item.reviewId]`；测试**逐条断言** `hash-r1`/`hash-r2`（非只查一条），强度足。批量下载仅走 `exportReview` 的 `ok` 分支构造 blob，`!ok`（409）只渲染 inline 错误、不下载（测试覆盖）。`blockingBySession` 只渲染 `ruleId × count`，类型无原值字段。jump→②→改处置命中 `guarded()`（`cur.signed` 真）→ 作废确认（守卫代码未变，见 Minor-3）。**无跨污染、无绕过、无原值泄漏**。
4. **完成态语义**：出口② `onSubmittedAll` 经 effect+firedRef 仅在**每项**都有 ok 回执时触发一次，部分失败不触发、留重试，重试成功再触发（测试覆盖）；出口① submit 成功即 `onPublished`；两者 → `setCompleted(true)` → Stepper 已完成，与单会话「任一出口完成即完成」一致。
5. **状态机**：估算循环按 `genRef` 中止；改 target `invalidate()` 清估算+结果、复位 firedRef。发现两处 Minor：改 target **不复位 ack**（Minor-1）、直投主循环**不随 target 变更中止**（Minor-2）。向导 slow/timeout(12s)/branch_exists/publish_in_flight 分支齐备（branch_exists 有测试）。
6. **类型镜像**：`PublishBatchPlan`/`PublishBatchRecord`/`PublishBatchStageResult`/`PublishBatchSubmitResult`/`PublishError.blockingBySession`+`reviewId` 与 daemon `uiSafeBatchPlan`（publish.ts:302-326）及批量路由错误体**逐字段吻合**（branch/targetBranch/prTitle/prBody/commitMessage/recordCount/ghAvailable/stagedFiles/commands/engine/compareUrl/totalRecordBytes/records[{sessionId,recordPath,provenancePath,recordBytes,contentHash,messages}]）。
7. **client/types 未扰动 provider**：批量表面已随更早提交落地，与 provider 类型（ProviderTarget 等）在同文件和平共存，typecheck/build 全绿；provider 工作（settings-provider-management）已单独归档提交，无交叉扰动可见。

### 场景 → 实现/测试对照（ui-batch-exits）

| Requirement | Scenario | 实现 | 测试 |
|---|---|---|---|
| 批量出口页 | 多会话双批量卡 | ReviewView.tsx:311-323 + BatchExitCards | ReviewView『batch exit cards…every item signed』+ BatchExitCards preflight |
| | 单会话保持单出口 | ReviewView isMulti 分支 | ReviewView『N=1…renders ExitCards / no batch-exit-cards』|
| | 批量导出逐条 gated export | BatchExitCards.tsx:76-104 | BatchExitCards『exports each…refused inline (M3)』|
| 批量发布向导 | 预览枚举记录 | BatchPublishWizard.tsx:242-263 | BatchPublishWizard『preview table + branch』|
| | 逐会话拒绝跳回过守卫 | Wizard jump + ReviewView onJumpToSession | Wizard『groups refusal…jump callback』+ ReviewView『jumps to session at ②』|
| | gh-free 兜底 | ManualFallback | Wizard『gh-free…manual fallback commands』|
| | 发布完成旅程 | onPublished→setCompleted | ReviewView『successful batch publish 已完成』|
| 批量直投 | 聚合估算求和 | BatchSubmitPanel.tsx:176-177,249-255 | BatchSubmitPanel『aggregate total + count』|
| | 每条内容绑定 consent | Panel.tsx:126-150 | BatchSubmitPanel『each consent bound…hash-r1/hash-r2』|
| | 单条失败不停批 | onRunAll 捕获 per item | BatchSubmitPanel『keeps going…retry…完成 only after』|
| | 改 target 失效估算 | invalidate() | BatchSubmitPanel『invalidates…target changes』|

---

## 自报偏离判定

- **(a) 向导内部 testid 统一 `batch-` 前缀**：**接受**。避免与冻结单向导 testid 碰撞，前缀一致、可读。
- **(b) `onSubmittedAll` 用 effect + firedRef**：**接受**，已核对——重试路径经 `results` 变更触发、`firedRef` 保证至多一次、`invalidate()` 复位，语义正确。

---

## 发现清单

### Blocker
无。

### Major
无。

### Minor

**Minor-1　改 target 不复位 ack（场景措辞 vs 实现）**
- 位置：`BatchSubmitPanel.tsx:87-92`（`invalidate()` 清 estimates/results，不动 `ackTos`/`ackRetention`）。
- 问题：`ui-batch-exits` 场景「Target change invalidates estimates」正文说 “blocked until re-estimated **and re-acknowledged**”，但实现只清估算（`allEstimated=false` ⇒ `canRun=false`），ack 勾选保留，用户改 target 后无需重勾。
- 评估：与**冻结的单会话** `SubmitPanel.invalidate()` 行为一致（design 明确「same invalidate() pattern」），且每条 consent 在重估后重新绑定新 `contentHash`/`estimatedTokens` ⇒ 内容绑定不失真、run 确实被拦。属场景措辞强于实现的既定 UX，非安全缺陷。
- 建议：二选一——软化场景正文为「清空估算并拦截 run 直至重估」，或（未来一并调整单/批）在 `invalidate()` 内复位两个 ack。不阻塞归档。

**Minor-2　直投主循环不随 target 变更中止（估算循环会）**
- 位置：`BatchSubmitPanel.tsx:154-167`（`onRunAll` 无 `genRef` 检查；provider/model/mode 三个 select 在 `running` 时未禁用）。
- 问题：直投进行中改 target，估算循环有 `genRef` 中止而**直投循环没有**。因 `submitItem` 读的是启动那次渲染闭包的 `providerId`/`est`，已发出的 consent **内部自洽**（旧 target + 旧 hash，无污染）；但 UI 可能显示新 target 而循环仍在跑旧的，且旧 run 跑完仍可能触发 `onSubmittedAll`。
- 建议：run 期间禁用三个 select，或 `onRunAll` 每次迭代校验 `genRef`。低风险，不阻塞。

**Minor-3　jump→②→改处置的作废守卫组合未显式断言（测试缺口）**
- 位置：`ReviewView.test.tsx`『jumps to session at ②』只断言 current 切换 + 展示 disposition-workspace，未接着断言改处置弹 `dialog-confirm`。
- 评估：跳到的必是已签项，改处置走的 `guarded()` 与切片 1 已测的「编辑已签项→作废确认」是同一代码路径，功能正确；仅组合未再断言。建议补一条 `disp-*` 点击 → `dialog-confirm` 出现的断言。

**Minor-4（informational）　下载路径在 jsdom 触发导航告警**
- 现象：测试输出有 `Not implemented: navigation` 报错（`anchor.click()` 带 download 属性，jsdom 不支持导航）。全部用例仍 **passed**，真实浏览器正常。纯测试环境噪声，非产品问题。

---

## Verdict: CLEAN

`ui-batch-exits` 11 场景全覆盖、REMOVED delta 归档安全、N=1 四个冻结组件零改动、安全轴（逐条内容绑定 consent 逐条断言、下载仅 gated ok 分支、拒绝只吐 ruleId/count、jump 后仍过作废守卫）全部守住，类型镜像与 daemon 逐字段吻合，两处自报偏离可接受。所列 Minor 均为场景措辞对齐 / 竞态加固 / 测试补断言的打磨项，不阻塞归档。建议顺手处理 Minor-1（措辞或复位 ack）与 Minor-2（run 期禁用 select），非 ship 前置条件。

---

## Fix resolution (lead, 2026-07-10)

- Verdict CLEAN，无必修项。M1：spec 场景措辞已软化（run 由重估算门控，ack 门控语义与单会话一致）；M2：BatchSubmitPanel 运行期禁用三个 target select；M3：jump-to-session→改处置→作废确认的组合断言已补（断言 dialog-confirm 弹出且 setDisposition 未被直接调用）。M4 informational（jsdom 下载告警）记录不处理。
- 流程备注：api/types.ts、api/client.ts 的批量 client 表面被并行会话的 ship 提交 e2358b2（settings-provider-management）意外卷入先行落地——内容经本评审核对正确（镜像 daemon uiSafeBatchPlan 逐字段吻合），仅历史归属混入，不重写历史，ship-log 记录在案。
- 收官复验：全仓 343 passed / 1 skipped / 0 failed；typecheck 绿；strict valid。

**Final verdict: CLEAN**
