# 评审报告 — mosga-v04-session-picker（对抗性评审）

评审对象：工作树未提交改动（`git diff` + 新增文件）。
验证结果：`npm run typecheck` ✅ / `npm run build` ✅ / `npx vitest run` **242 passed (45 files)** ✅ / `rasen validate mosga-v04-session-picker --strict` ✅。

---

## 逐轴结论

1. **规格符合性**：15 个 ui-session-queue 场景中 14 个有对应实现+测试；1 个（hover 完整路径）已实现但无测试。review-ui 两个 MODIFIED 场景标题逐字未改、正文对应实现。**1 处规格正文与实现相反**（clear 作用域），见 Major-1。
2. **N=1 等价性**：`maxEnterable`/`onSign`/`nextUnsigned` 在 n=1 时退化路径与 v03 逐条核对一致；re-lock 掉签、gate 409 export 回退、void→重锁均保留。唯一行为变化是 restart 现在会弹确认（Open Q2，设计已采纳），见 Minor-4。**结论：等价（含一处有意的 restart 变化）**。
3. **队列状态机**：`activeStep` 由 clamp effect 正确回钳；自动前进的环绕搜索边界正确（跳过 from、全签返回 -1→④）；全签后改处置正确重锁。**发现 `error`/`focusRuleId` 切换队列项时不清空的状态泄漏**，见 Minor-1。
4. **选择集边界**：上限 20 在 toggle/selectAll 两处都有执行点；跨文件夹累计正确；串行失败续跑用重建数组无索引错位。**clear 清空全集与规格正文冲突**（Major-1）。
5. **安全轴**：recommended/show-all 防线原样保留（默认 `showAll=false`，toggle 重取并作废缓存）；BatchExitSummary 仅在 `result.ok` 分支构造 blob，409 分支只显错不下载；进入 ④ 唯一路径是全签 `onSign`，`navigate`/clamp 均无法在未全签时进入 ④。**无绕过路径**。
6. **回归面**：Stepper / ExitCards / lock-badge 等冻结组件不在 diff 内；ConfirmDialog 默认 testid `dialog-confirm` 及派生按钮向后兼容；`Gate locked/unlocked` 文案未动；旧 Picker 引用已清干净（仅剩 `SessionPicker` 与无害注释）。
7. **代码质量**：风格/注释密度与既有一致；无死代码；`aria-expanded`/`aria-pressed` 补齐。三处 design 偏离判断见下。

---

## 自报 design 偏离判定

- **(a) Stepper `signed` 传 `allSigned`**：**接受**。安全关键的 void 守卫读的是 `cur.signed`（ReviewView.tsx:124），与 Stepper 展示解耦，逐项作废保护完好。副作用：中途切回一个已签项时，Stepper 显 `已解锁` 且该项 chip 显 `当前`（非 `已签署`），该项「已签署」在 UI 上无显式提示——纯观感，记 Minor-2。
- **(b) ConfirmDialog `testid` prop**：**接受**。默认值保持 `dialog-confirm`，旧测试 testid 不破。
- **(c) 清空整个跨文件夹选择集**：**部分接受**。权威文档（office-hours B1「全选本文件夹 / 清空」）确实把 clear 标为无作用域，故行为本身可采纳；但 **spec 正文写的是 "clear controls scoped to the shown folder"，与实现相反**，归档前必须改正，见 Major-1。

---

## 发现清单

### Blocker
无。

### Major

**Major-1　规格正文与实现相反：clear 作用域**
- 位置：`specs/ui-session-queue/spec.md:26`（"the grid SHALL offer select-all and clear controls **scoped to the shown folder**"） vs `packages/ui/src/components/picker/SessionPicker.tsx:126`（`clearSelection = () => setSelection(new Map())`，清空全集）。
- 问题：normative SHALL 文本声明 clear 按当前文件夹作用域，实现却清空整个跨文件夹选择集，且测试（`SessionPicker.test.tsx:145`）固化了全集清空。归档后主规格将与代码不符（spec-driven 仓库不可接受）。
- 建议修复：`ui-session-queue` 是 ADDED 能力，正文可自由改写。把该句改为「select-all 作用域为当前文件夹，clear 清空整个跨文件夹选择集」以对齐 office-hours 权威与实现。（可选 UX 加固：清空按钮提示总数或加二次确认，防止跨 3 文件夹选了 15 项后误清空——非阻塞。）

### Minor

**Minor-1　切换队列项时 `error`/`focusRuleId` 未重置（状态泄漏）**
- 位置：`packages/ui/src/components/ReviewView.tsx:217-220`（`selectItem` 仅 `setCurrent`）。
- 问题：`error` 与 `focusRuleId` 是旅程级 state。切到另一会话时，上一会话的错误横幅仍显示，直到下次 mutation 才清；`focusRuleId` 也带到新会话的 ② 工作区（指向可能不存在的规则）。`exported` 已是 per-item 不受影响，`activeStep` 已由 clamp 处理——唯独这两个漏了。
- 建议：`selectItem` 内 `setError(null); setFocusRuleId(null);`。

**Minor-2　中途已签项无「已签署」显式提示**
- 位置：`QueueBar.tsx:38`（`isCurrent ? '当前'` 优先于 `isSigned`）+ Stepper 传 `allSigned`。
- 问题：切回一个已签的非末签项时，chip 显「当前」、Stepper 显「已解锁」，该项已签署状态在 UI 上不可见（守卫仍生效，纯观感）。偏离 (a) 的已知代价。
- 建议：可在 QueueBar 当前项内并列一个已签角标，或 chip 文案「当前 · 已签署」。非阻塞。

**Minor-3　场景/分支缺测试覆盖（实现均在）**
- `ui-session-queue`「Project row reveals the full path on hover」：`SourceTree.tsx:119` 已加 `title={cwd ?? key}`，但无测试断言。
- `BatchExitSummary` 的逐条下载与 409 分支（`BatchExitSummary.tsx:31-57`）无测试；N>1 测试只断言了占位卡存在（`ReviewView.test.tsx:216-229`）。
- 建议：补一条 `download-item-<id>` 点击断言（mock `exportReview` 返回 ok → 触发 blob；返回 409 → 显示 `导出被拒绝`）与一条 `title` 断言。低优先。

**Minor-4　N=1 restart 行为变化（有意）**
- 位置：`ReviewView.tsx:203-207` `requestRestart`。
- 说明：v03 单会话 restart 直接返回；现在 `touched || 已签` 会先弹 `restart-confirm`。这是设计采纳 Open Q2 的结果、规格「Abandoning the queue prompts a confirmation」覆盖，非缺陷；仅提示 task 3.1「N=1 byte-identical」措辞略过强，restart 路径是有意的新增横切行为。无需改代码。

**Minor-5　`.jsonl` 文件名与内容格式**
- 位置：`BatchExitSummary.tsx:45`（`JSON.stringify(result.data.session)` 整体作为单行，文件名 `<id>.sanitized.jsonl`）。
- 问题：JSONL 惯例为逐条一行，这里把整个 session 对象序列化成单行却用 `.jsonl` 扩展名，略有名不副实。属过渡态（切片 3 替换），非阻塞；如就地修可考虑 `.sanitized.json` 或逐 message 换行。

---

## Verdict: FIX_REQUIRED

唯一必修项是 **Major-1**（规格正文与实现相反，spec-driven 仓库归档前必须对齐，成本为一句 ADDED 正文改写）。Minor 均可择机处理，不阻塞。修掉 Major-1 后即可 CLEAN 归档。

---

## Fix resolution (lead, 2026-07-10)

- **Major-1 FIXED**: specs/ui-session-queue/spec.md 正文改为「select-all 作用域为当前文件夹，clear 清空整个跨文件夹选择集」，与实现/测试对齐；strict validate 复验通过。
- **M1 FIXED**: ReviewView.selectItem 切换队列项时重置 error/focusRuleId，杜绝跨会话泄漏。
- M2/M3/M4/M5：accepted-known，记入 portfolio humanFollowUps（M3 测试补齐可随切片 3 顺手做）。
- 复验：packages/ui 44/44 全绿；全仓 typecheck 通过。全量 vitest 中 direct-submit 的 1 个失败源自并行会话（settings-provider-management）对该包的未提交改动，与本切片无关（本切片零 daemon/publisher/direct-submit 改动）。

**Final verdict: CLEAN（修复后）**
