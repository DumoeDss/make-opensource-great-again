# mosga-v04 Planning Context（持久 planner 种子，LEAD 维护）

> ⚠ 工具链：CLI 为本地 fork **rasen**，一切 `openspec <cmd>` 替换为：
> `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`
> 变更产物写 `rasen/changes/<name>/`；`openspec/` 目录为冻结遗留，只读。禁止全局安装官方 @fission-ai/openspec。

## User intent（逐字要点，2026-07-09）

"当前页面一个是不方便查看，一个是没有多选，每次只能 review 一个 session，对于有大量数据的用户来说并不友好。参考 elftia……能够选择单个 session，也可以选择多个 session/全选，然后进入下一步。" 用户拍板下游语义 = **队列 + 批量出口**；流程 = rasen 流程（propose→实现→评审→ship/archive）。

## 权威设计文档（planner 必读，实现以此为准）

`rasen/office-hours/session-picker-batch-journey.md`（Status: APPROVED）。含 elftia 调研结论、B1 选择页 / B2 队列旅程 / B3 批量出口后端 / B4 批量出口 UI、切片划分、Later、Open Questions（带建议，非阻塞）。

## Decompose 计划（严格串行，3 子变更）

1. **mosga-v04-session-picker**（纯前端）：B1+B2。左树（source→project，hover 完整路径，recommended/show-all 防线保留）+ 右卡片网格（多选/全选/跨文件夹选择集，上限 20）+ 队列旅程（②③逐 session、全部签署→④；N>1 时 ④ 为汇总+逐条导出+出口占位卡）。
2. **mosga-v04-batch-publish-core**（纯后端，依赖 1）：B3。publisher `plan/stage/submitBatchContributionAsync`（N=1 退化单会话分支；N>1 `contrib/<alias>/batch-<hash8>`；逐条 precheck 聚合；alias 一致性断言）+ daemon `POST /api/publish/batch/plan|stage|submit`（`{reviewIds}` 1–20 去重；与 per-review 路由共享互斥；per-review 路由不动）。
3. **mosga-v04-batch-exits-ui**（纯前端，依赖 2）：B4。批量向导 + 批量直投（逐条 estimate 求和 + 逐条 consent 绑 contentHash + 进度/单条重试，零 daemon 改动）+ 批量导出；N=1 全部退化为现有组件。

## 背景（v0.3 已全部归档）

- 8 包 monorepo：contracts/session-readers/sanitizer/daemon/ui/publisher/direct-submit + apps/desktop。npm workspaces + tsup + vitest；包间依赖写 `"*"`。
- UI：React 18 + Vite + Tailwind 3 + omnicross 设计系统（cva/lucide/clsx/tailwind-merge + radix dialog）；旅程容器 `packages/ui/src/components/ReviewView.tsx`；入口 App.tsx（Picker↔ReviewView 切换）。
- daemon 路由 `packages/daemon/src/app.ts` + `publish.ts`；publisher `pr.ts/export.ts/runner.ts`（async runner 已就位）。
- **maxReviews 默认 50 LRU 驱逐** → 批量上限 20 的由来。
- 测试 219 全绿基线；`npx vitest run --testTimeout=20000` 从根跑；pr.test.ts 真实 git 测试 Windows 下需高 timeout（避免新增 real-git 测试，注入 fake AsyncCommandRunner）。

## Gotchas（worker 必读）

- **rasen archive 按 scenario 标题逐字匹配**：MODIFIED 块内保留原场景标题逐字不变，只改 WHEN/THEN 正文；新增场景随意。
- 禁改归档产物（rasen/changes/archive/** 与 openspec/**）。
- `rasen/changes/codex-session-reader/` 是另一条并行变更（他人产物），**勿动**。
- E 盘空间紧张；Tauri CSP 禁外部字体/CDN（相对时间用 Intl，不引库）。
- omnicross 参考只读（E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross）；elftia 参考只读（…\elftia\elftia\elftia）。
- v03 决策沿用：dataRepoPath 信任模型不放宽；签署为客户端态；异步 runner 是唯一"换容器"例外。
