# 会话选择页重做 + 批量审阅旅程（session-picker-batch-journey）

Status: APPROVED（用户 2026-07-09 拍板：队列 + 批量出口，走 rasen 流程）
Authority: 本文档是 mosga-v04 portfolio 三切片的权威设计；细节冲突时以本文档为准。

## 用户意图（逐字要点，2026-07-09）

"当前页面一个是不方便查看，一个是没有多选，每次只能 review 一个 session，对于有大量数据的用户来说并不友好。参考 elftia 这个左边是列表（包含 codecli 的类型，下面是文件夹层级（hover 显示完整路径），点击文件夹层级右边显示该文件夹内所有的 session（hover 能显示更多标题）），能够选择单个 session，也可以选择多个 session/全选，然后进入下一步。"

用户拍板的下游语义：**队列 + 批量出口** —— ②处置→③签署逐个 session 进行（签署是对单个会话内容的人工确认，安全上必须逐个），④ 出口攒到最后统一批量出：出口① N 条记录合并一个分支/一个 PR，出口② 批量逐条直投带总成本估算。

## elftia 参考实现调研结论（E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia）

- 左侧栏 = source（CLI 类型）→ project（文件夹）→ session 三级**懒加载树**（首次展开才请求子级，cache-on-expand）；chevron 与行主体是**分离热区**（点 chevron 只展开/折叠，点行主体打开右侧看板）。
- 右侧 = 会话卡片网格（虚拟化 @tanstack/react-virtual，240px 最小列宽）；卡片 = 标题 truncate + CLI 类型 Badge + 相对时间。
- 相对时间**不用第三方库**：`Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })`，<1min→秒 <1h→分 <1d→时 <7d→天，≥7d 回退绝对日期；中文环境自动输出「10小时前/前天」。
- elftia 没有勾选式多选（是按作用域批量导入 + 确认弹窗）；也**没有**做 hover 完整路径/完整标题（数据有但没接 tooltip）。→ 我们用原生 `title` 属性补上这两点，勾选式多选按用户要求自建。
- 虚拟化本轮**不做**（mosga 单文件夹会话量级为几十~几百，静态 `grid-cols-[repeat(auto-fill,minmax(240px,1fr))]` 足够；量级上来再做，记入 Later）。

## mosga 侧现状约束（实现者必读）

- daemon API 已是三级：`GET /api/sources` → `/api/sources/:id/projects?all=1` → `.../projects/:key/sessions`；树形导航**零后端改动**。`SessionRef` 已带 `title/cwd/updatedAt/sizeBytes`。
- 「recommended（公开 git remote）默认 + show all 显式开启」是防泄漏第一道防线，**必须保留**在新树里。
- review 是 daemon 内存态，`maxReviews` 默认 50 LRU 驱逐 → **一次批量选择上限 20**，超出提示分批（守住驱逐边界；上限常量化，Later 可调）。
- 出口① 契约现为单 session 确定性：分支 `contrib/<alias>/<sessionId>`、`recordCount` 恒 1、PR body 单会话表格。批量需 publisher 新增多 record 计划（见 B3）。
- 出口② 的 consent 按 `contentHash` 逐条绑定内容 → 批量直投必须**逐条生成 consent 记录**（一次勾选 ack，N 条 consent 各绑各的 hash），**纯前端循环现有端点即可，零 daemon 改动**。
- v03 冻结的测试契约（data-testid、gate 文案等）中，Picker 的 h1/结构本轮**允许改**（这是新变更周期，走 MODIFIED 规格）；rasen archive gotcha 依旧：**MODIFIED 场景标题逐字不变，只改正文**。

## B1 选择页重做（切片 1 前半）

两栏布局（AppShell 内容区内部，不动 NavRail）：

**左树**：
- source 组头：displayName + project 数徽章；展开时懒加载 projects。
- project 行：label + recommended 小徽章；`title={cwd ?? key}` 原生 tooltip 显完整路径；点击行主体 → 右侧显示该文件夹会话卡片；show-all 开关保留在树顶（含现有提示文案语义）。
- 树顶保留 source 级说明 + 错误条。

**右卡片网格**：
- `grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]`；卡片 = checkbox 选中态 + 标题（truncate + `title={完整标题}`）+ 相对时间（Intl.RelativeTimeFormat，封装 `lib/relativeTime.ts`）+ 人性化 sizeBytes。
- 卡片整体点击 = 切换选中；头部「全选本文件夹 / 清空」；选中卡片有明显选中描边。
- **选择集跨文件夹/跨 source 累计**：key = `sourceId+projectKey+sessionId`，持有 SessionRef 引用。
- 底部常驻选择栏（有选中时浮现）：已选 N（含跨文件夹计数）+「开始审阅 N 个会话」按钮 + 上限 20 提示。

**进入下一步**：逐个 `POST /api/reviews`（串行，带「正在扫描 k/N」进度），全部成功 → 把 `CreateReviewResponse[]` 队列交给旅程。单选 = 长度 1 队列，行为与今天等价。个别失败：提示失败项，可去掉失败项继续。

## B2 队列旅程（切片 1 后半）

- App 状态：`{ queue: QueueItem[], currentIndex }`，QueueItem = CreateReviewResponse + 客户端签署态。
- ②③ 逐 session：Stepper 上方加队列条「会话 k/N · 标题」+ 可点击的队列项列表（已签署 ✓ / 当前 / 待处理）。
- 签署第 k 个后：k < N → 自动切到第 k+1 个的 ②；全部签署 → ④。
- ④（本切片过渡态）：N=1 时与现有 ExitCards 完全一致；N>1 时显示已签署会话汇总列表 + 「仅导出脱敏文件」逐条下载 + 出口①② 占位卡（「批量出口将在后续切片可用」，与 v03 切片 2 的出口① 占位同模式）。
- 签署作废规则不变且 per-session：队列中任何 session 的处置变更 → ConfirmDialog → 作废**该 session** 签名 → ④ 重锁（因为不再是全部已签署）。
- 服务端 gate 409 依旧是最终防线，逐 review 生效。

## B3 批量出口①（切片 2 后端 + 切片 3 UI）

**publisher（`@mosga/publisher`）**：
- 新增 `planBatchContributionAsync(sessions[], options)` → `BatchContributionPlan`：逐 session `exportSession` + **逐条强制 precheck**；任一拒绝 → 聚合抛出（per-session blocking findings，见错误分类）。
- `recordCount = N`；`stagedFiles` = N×(record+provenance sidecar)；PR body = 批量汇总表（每行 sessionId/messages/recordPath）+ 共享 engine 停记 + 同意书；commit message `records: N`。
- **分支命名**：N=1 退化为现有 `contrib/<alias>/<sessionId>`（幂等兼容）；N>1 → `contrib/<alias>/batch-<hash8>`，hash8 = sha256(排序后 sessionId 列表 join('\n')) 前 8 位 → 同一集合确定性幂等，残留分支撞 `branch_exists` 语义与现有一致。
- **contributorAlias 必须全体一致**（同一 envelope 来源本就一致）；不一致 → 拒绝（config error，不静默取第一个）。
- `stageBatchContributionAsync` / `submitBatchContributionAsync`：镜像单 session 版（一个分支一次 commit N 对文件、一次 push、一次 gh pr create）。sync 版**不加**（CLI 批量不在本轮范围）。

**daemon**：
- 新路由 `POST /api/publish/batch/plan|stage|submit`，body `{ reviewIds: string[] }`（zod，1–20，去重）。per-review 路由**保留不动**。
- 逐 review gate 检查：任一 locked → 409 `GATE_LOCKED` + `reviewId` 指明是哪一个；未知 review → 404 指明。
- 预检拒绝聚合：`precheck_refused` 422 + `blockingBySession: [{ reviewId, sessionId, blockingByRule }]`（规则聚合计数，无原值）——UI 可跳该 session 的 ②。
- 互斥：与 per-review 路由**共享**同一 `publishInFlight` 布尔；批量 stage 状态 key = 排序 reviewIds join(',')。
- plan 返回 UI 安全子集扩展版：`records: [{ sessionId, recordPath, recordBytes, contentHash, messages }]`，总 `recordBytes`；依旧不含 record 字节；`compareUrl` 派生同现有。
- 错误分类沿用既有全套 code（repo_dirty / branch_exists / gh_unauthenticated / push_rejected / data_repo_unconfigured / git_unavailable / publish_in_flight）。

## B4 批量出口 UI（切片 3）

- ④ 统一出口页替换占位：出口① 卡 → 批量三步向导（预检（批量 plan）→ PR 预览（批量表格 + prBody `<pre>` + compareUrl）→ 提交/gh-free 兜底，语义与现有 PublishWizard 镜像，`precheck_refused` 逐 session 逐规则列出 + 「回到该会话②」跳转）。
- 出口② 卡 → 批量直投：provider/model/mode 一次选定 → 逐条 estimate 求和显示**总 token/总成本 + 条数**（逐条明细可折叠）→ 一次勾选双 ack → 循环逐条 submit（每条 consent 绑各自 contentHash），进度条 + 逐条回执/失败列表 + 单条重试。
- 「仅导出脱敏文件」→ 逐条触发 .jsonl blob 下载 + 全部下载。
- N=1 时全部退化为现有单会话组件（PublishWizard/SubmitPanel 保留复用），不破坏现有测试契约。

## 切片划分（严格串行）

1. **mosga-v04-session-picker**（纯前端）：B1 + B2。多选→队列→逐个②③→④过渡态（N>1 占位卡）。
2. **mosga-v04-batch-publish-core**（纯后端）：B3。publisher 批量三函数 + daemon batch 路由 + 注入 fake runner 测试（零真实 git/gh）。
3. **mosga-v04-batch-exits-ui**（纯前端，依赖 1+2）：B4。批量向导 + 批量直投 + 批量导出，替换占位卡。

## Later（本轮不做）

- 卡片网格虚拟化（@tanstack/react-virtual）；批量上限 >20（需 daemon maxReviews 联动）；会话搜索/过滤框；回执持久化 + 历史页（既有 open question）；CLI 批量发布（sync 版批量函数）；批量导出打包 zip。

## Open Questions（非阻塞）

1. 批量 PR 的 prTitle 格式——建议 `Add N sanitized sessions (<alias>)`，切片 2 planner 可直接采纳。
2. 队列中途放弃（部分已签署）是否需要「退出队列」确认——建议：restart 弹 ConfirmDialog 提示未完成项作废，切片 1 采纳。
