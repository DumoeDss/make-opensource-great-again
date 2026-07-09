# 评审报告 — mosga-v04-batch-publish-core（对抗性评审）

评审对象：工作树未提交改动（本切片仅 `packages/publisher/src/{batch.ts,pr.ts,index.ts}` + `packages/daemon/src/publish.ts` + 两个新测试文件）。并行会话对 `packages/direct-submit/**`、`packages/daemon/src/{secrets,providerStore}` 及 `submit.test.ts` 的改动**不在本切片范围**，已排除。

验证结果：`npm run typecheck` ✅ / `npm run build` ✅ / `npx vitest run packages/publisher packages/daemon packages/ui` **207 passed, 1 skipped（34 文件）** ✅（并行会话未引入失败）/ `rasen validate mosga-v04-batch-publish-core --strict` ✅。

---

## 逐轴结论

1. **规格符合性**：5 需求 13 场景**全部**有实现 + 测试对应，逐条核对见下表，无缺口。
2. **单会话零回归**：`pr.test.ts` / `template.test.ts` / `publish.test.ts` **未改动**且绿；`pr.ts` diff = 仅两个 `export` 关键字（`writeRepoFile`/`shellQuote`），无行为变化；N=1 退化测试逐字段锁定 branch/prTitle/prBody/commitMessage/commands/stagedFiles/records/recordCount == 单会话。**零回归确认**。
3. **安全轴（重点）**：422 两条路径都走同一 `aggregateBlockingByRule`，只吐 `{ruleId,count}`，原始命中值绝不出现（daemon 测试断言 raw AKIA/ghp_ 缺席）；`uiSafeBatchPlan` 不含 `fileContents`/`jsonl`/`dataRepoPath`，只给 `recordBytes`(计数)+`contentHash`(哈希)，与单会话 `uiSafePlan` 同配方；`stampedBatch` 对**每个** reviewId 逐个过 gate、首个失败即返回（无跳过路径），submit 的「已 staged」分支也会**重跑** `stampedBatch` 再 push（防 stage 后重锁）；plan 只读不上锁、stage/submit 共享 `publishInFlight`，双向互斥都有测试。**无泄漏、无绕过、无跳过 gate 路径**。
4. **状态机**：`batchKey` = 排序去重 reviewIds join(',')，N=1 时即 reviewId，与单路由共享 stageState（设计明确意图，语义一致无害）；submit stage-if-not-staged 镜像单路由；`branch_exists` 残留按 batchKey 判定并测试覆盖。
5. **确定性与幂等**：`hash8 = sha256(排序 sessionIds.join('\n')).slice(0,8)`，同集合任意顺序 → 同分支（测试断言）；重试触发 `branch_exists` 残留。分支哈希用 sessionIds、stageKey 用 reviewIds，各司其职均确定性。
6. **错误面**：自报 (d) N=1 `PublishRefusedError`→`BatchPublishRefusedError` 已实现且正确（batch.ts:146-153），N=1 拒绝经 daemon 统一成 422 blockingBySession；`exportSession` 抛错→500 的行为与单路由 `computePlan` **一致**（且 `stampedSessionFor` 已保证到达的会话是已解锁合法态，实际不可达）。
7. **测试质量**：N=1 退化断言到字节级；push-rejected 区分（publisher 单测 + daemon happy）、mutex 双向、size 0/21、404/409/422、branch_exists 残留均有断言。存在若干 daemon 层非 happy 分支未覆盖（见 Minor-1）。

### 场景 → 实现/测试对照

| Requirement | Scenario | 实现 | 测试 |
|---|---|---|---|
| 批量 plan + 聚合预检 | Refusals aggregate | batch.ts:166-186 | publisher『aggregates…no fail-fast』+ daemon『aggregates per session』|
| | Clean batch N records | batch.ts:196-225 | publisher『one row per session』(recordCount 2) |
| | Alias mismatch refused | batch.ts:110-117 | publisher『refuses an alias mismatch』|
| 确定性分支 | Same set→same branch | batch.ts:194-195 | publisher『deterministic…any order』|
| | N=1 degrades | batch.ts:130-154 | publisher『degrades…byte-for-byte』|
| stage/submit 一 commit 一 PR | Stage N pairs one commit | batch.ts:234-268 | publisher『one branch』+ daemon『one commit for N』|
| | Submit push once + 区分 | batch.ts:276-308 | publisher『pushes once』+『rejected push distinctly』|
| daemon 路由逐 review 归因 | Locked review named | publish.ts:244-262 | daemon『names locked review 409 GATE_LOCKED』|
| | Refusal aggregated per session | publish.ts:281-298 | daemon『aggregates per session』|
| | Oversized/empty rejected | publish.ts:40,454 | daemon『rejects empty or oversized』(0/21) |
| 共享互斥 + UI-safe | Batch/single exclude | publish.ts:476-495 | daemon 两条 mutex 双向测试 |
| | Plan no record bytes | publish.ts:302-326 | daemon『UI-safe subset…no record bytes』|

---

## 自报偏离判定

- **(a) 重复 sessionId 检查前移到 config 检查（precheck 前）**：**接受**。alias/duplicate 都是配置完整性检查，前置以 fail-fast 合理，无下游副作用（batch.ts:110-126）。
- **(b) batch PR body 重写段落而非从 pr.ts 抽共享助手**：**接受**。`pr.ts renderPrBody` 逐字节未动（template.test 绿）。代价见 Minor-2（attestation/consent/engine-stamp 文案在两处复制，需手工保持同步）。
- **(c) submitBatchContributionAsync 复制单 submit 函数体**：**接受**。设计明确允许小重复。代价同 Minor-2（push/PR 序列两处复制）。
- **(d) N=1 refusal 包成 BatchPublishRefusedError 统一 daemon 422 面**：**接受**，已核对实现正确（batch.ts:146-153）。

---

## 发现清单

### Blocker
无。

### Major
无。

### Minor

**Minor-1　daemon 层批量 submit/stage 的若干非 happy 分支未覆盖**
- 位置：`packages/daemon/src/__tests__/publish-batch.test.ts`。
- 未覆盖：批量 `submit` 的 `gh_unauthenticated`→409、`push_rejected`→409、`submit_failed`→500；批量路由的 `data_repo_unconfigured`/`git_unavailable`/`repo_dirty`；submit 的「已 staged 复用 plan」分支。
- 评估：这些分支逐字镜像单路由（共享 `isGitAvailableAsync`/`ghAuthenticatedAsync`/`isRepoClean` 助手，单路由 `publish.test.ts` 已测），且 push-rejected 区分在 publisher 单测已锁——**规格场景不失守**。仅为纵深防御的覆盖缺口。
- 建议：补 3-4 条 daemon 断言（复用现有 FakeAsyncRunner 的 `ghAuthed=false`/`pushRejected=true`/`dirty=true`/`remoteUrl` 开关，成本极低）。

**Minor-2　偏离 (b)/(c) 带来的文案/序列复制漂移风险**
- 位置：`batch.ts:335-387`（renderBatchPrBody 复制 attestation/consent/provenance-stamp 段落）、`batch.ts:276-308`（submit 复制 push+`gh pr create` 序列）。
- 问题：与 `pr.ts` 对应段落/序列是**手工复制**，非共享助手。日后改单会话 attestation 或 push 逻辑不会自动传播到批量，可能静默分叉。
- 建议：接受本切片现状（设计已授权），但在 `batch.ts` 顶部注释或 tasks 里记一条「与 pr.ts renderPrBody/submitContributionAsync 保持同步」的维护约束；切片 3 若触及可考虑抽 `pushAndOpenPr` 共享助手。

**Minor-3　N=1 跨路由重复 stage 的退化边界（informational）**
- 位置：`publish.ts:648`（batchKey===reviewId 与单路由共享 stageState）。
- 问题：先经单路由 `POST /api/reviews/r1/publish/stage` 置 `stageState['r1'].staged=true`，再经批量 `POST /api/publish/batch/stage {reviewIds:['r1']}`，因共享 staged 标志会**跳过** `branch_exists` 守卫、重跑 `git checkout -b <同名分支>` → 真 git 报错 → 500 `stage_failed`（而非干净的 `branch_exists`）。
- 评估：UI 中 N=1 只走单一路由、不混用，不可达；且共享 stageState 是设计明确意图。仅记录该退化边界，不阻塞。

**Minor-4　daemon 层 alias-mismatch / 同会话双 reviewId 走未类型化 500（informational）**
- 位置：`publish.ts:280-298`（computeBatchPlan 只 catch `BatchPublishRefusedError`）。
- 问题：`planBatchContributionAsync` 对 alias 冲突/重复 sessionId 抛普通 `Error`，daemon 未捕获 → 500（非类型化 code）。
- 评估：批量 reviewIds 同源一个 envelope ⇒ alias 恒一致；选择集按 sessionId 去重 ⇒ 无同会话双选。实际不可达，且与单路由「意外异常即 500」一致。仅记录。

---

## Verdict: CLEAN

规格 13 场景全覆盖、单会话零回归确认、安全轴（预检聚合只吐 ruleId/count、UI-safe plan 无 record 字节、逐 review gate 无跳过、互斥共享）全部守住，四处自报偏离均可接受。所列 Minor 均为测试纵深覆盖或复制漂移的维护提示，不阻塞归档。建议顺手补 Minor-1 的几条 daemon 断言并加 Minor-2 的同步约束注释，但不作为 ship 前置条件。

---

## Fix resolution (lead, 2026-07-10)

- Verdict CLEAN，无必修项。M1（批量路由非 happy 分支 4 条断言）+ M2（batch.ts 两处镜像维护注释）已由 implementer 顺手补齐：publisher+daemon 154 passed / 1 skipped / 0 failed，typecheck 绿。
- M3/M4（informational，UI 不可达路径）记录在案不处理。

**Final verdict: CLEAN**
