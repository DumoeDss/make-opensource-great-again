# Handoff: mosga-v03 — lead #1

## Original intent

用户两阶段请求（2026-07-09）：
1. `/opsx:office-hours`（原话）："现在来优化前端页面显示，当前的前端只能说有个功能，不管是实用性还是美观程度都非常的差，让人没有用下去的欲望。omnicross的那种前端设计（设计风格有些偏向claude）就挺好的，你看怎么修改一下设计呢？从一个产品经理的角度来看。"
   - 会话中用户拍板：范围 = C（视觉系统 + 流程重构 + 补齐 HF 发布流程）；设计参照 = 直接按 Claude 风格 + 后补了 omnicross 本地路径 `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`。
2. `/opsx:auto auto-decompose no gate，你来推进执行所有任务。` —— 预授权连续推进，gates 报告不阻塞。

## Position

Pipeline: auto-decompose（decompose taken → 3 子片，严格串行，childPipeline = small-feature）。
**Portfolio 已 100% 完成**：三子片全部 propose→apply→verify→review-loop→ship→archive 走完并推送。会话尾声顺手完成了 README 快速开始更新（用户追问"readme有更新启动/build命令吗"）。当前无进行中 stage。

## Done / Remaining

Done（全部推送至 origin/main，最新 `3f72218`）：
- 设计文档 APPROVED：`rasen/office-hours/frontend-ui-redesign.md`（3 轮对抗评审 22 项修复，9/10）+ 线框 `frontend-ui-redesign-wireframe.html`
- `mosga-v03-ui-design-system`：ship `49e430d` / archive `b479a3f`（omnicross 令牌+6 基元+lucide，评审 CLEAN）
- `mosga-v03-ui-journey-shell`：ship `206f1a6` / archive `92ca67d`（NavRail+四步旅程+签署卡+双出口卡，0B/0M）
- `mosga-v03-publish-exit-one`：ship `3897486` / archive `4d61170`（daemon publish 路由+异步 runner+出口① 向导，CLEAN，安全轴对抗通过）
- portfolio 收官 `005cde6`；README 更新 `3f72218`
- 测试 189 → 219 全绿；工作树干净

Remaining（本 portfolio 无遗留 stage；后续工作见 portfolio-run.json `humanFollowUps`）：
1. GUI 冒烟测试（新四步旅程从未人工走过；含出口① 对真实 data-repo clone 的 repo_dirty/branch_exists 错误路径）
2. 出口① 真实可用前的产品决策：HF 组织/数据仓库命名 + 数据集许可证（设计文档 Open Questions）
3. 可选 fast-follow：M2（stage_failed 500 回显 git stderr）、M1（focusRuleId 重复跳转 no-op）、切片 2 F2（export 409 分支无测试）
4. publisher `pr.test.ts` 真实 git 测试在 Windows 下超时抖动（隔离下也要 20s）——建议永久调高该测试 testTimeout 或串行化 git 测试
5. Tauri 壳未重建（daemon 直接 serve 新 UI 构建产物，重建 `apps/desktop` 即可）

## Key decisions (and why)

- **设计系统按文件级移植 omnicross（MIT）而非重画** —— 两项目同构（Tauri+daemon+React/Tailwind），形成产品家族；勿重新发明令牌。
- **信息架构病根论**：实用性差源于 5 平铺 tab 掩盖线性旅程 → 四步旅程 + 常驻步骤条 + 锁徽章四态（还差N/已解锁/已签署/已完成）。
- **签署为客户端态**（v0.x）：刷新失效；签署后改任何处置 → ConfirmDialog → 作废+重锁④；服务端 gate 409 是最终防线。
- **dataRepoPath 信任模型**：仅启动时配置（`--data-repo`），永不经 HTTP 写入/回显；设置页只读展示。与 providerKeyConfigPath 同模式，勿放宽。
- **异步 CommandRunner 是"换容器不换逻辑"的显式例外**：接口加宽行为不变，同步接口保留供 CLI/测试；daemon 单 in-flight publish 互斥锁。
- **L3（归一化统计）保留既有 batch-by-type 控件但不参与门禁计数** —— 评审裁定"零行为变化"优先于设计文档"只读"字面；delta spec 措辞已改为 gating 语义。
- **出口① gh-free 路径**：stage 显式落盘按钮（避免意外写用户 clone）→ 手动命令 + compareUrl（从 owner/repo 重建，剥离凭据）兜底。
- 全部决策链与三个 planner 决策记录在 `rasen/changes/mosga-v03/planning-context.md`（successor planner 必读）。

## Dead ends & gotchas

- **CLI 是 rasen fork 非官方 openspec**：一切 `openspec <cmd>` → `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`；派发 worker 时必须在 prompt 里写明。fork dist 偶发重建窗口 → 瞬时 ERR_MODULE_NOT_FOUND，重试即可。
- **工作区根已迁移 `openspec/` → `rasen/`**（本次运行执行了 `rasen migrate`，copy-only）：产物读写 `rasen/changes/`；`openspec/` 冻结只读。注意 migrate 不搬 `office-hours/`（当时手动 cp 过去的）。
- **rasen archive 按场景标题逐字匹配**（specs-apply.ts findMissingCurrentScenarios）：MODIFIED 块内改 scenario 标题 = 归档拒绝（transactional、一次只报第一个）。规则：改正文不改标题；新增场景随意。切片 2 踩了 4 处、切片 3 靠预警避开。
- **implementer-s3 曾因 API 流中断挂在 4/25**：SendMessage 同名 agent 即 warm 恢复（Tier A），恢复时让它先 typecheck 检查截断写入——有效，无返工。
- E 盘空间紧张（v02 遗留）；npm 不支持 `workspace:*`（包间依赖写 `"*"`）；Tauri CSP 禁外部字体/CDN。

## Eliminated hypotheses

none（本 run 无 debug 型排查；唯一"疑似损坏"是 rasen dist 瞬时缺文件，已确认为重建窗口竞态而非损坏）。

## Working set

- 变更产物：`rasen/changes/archive/2026-07-09-mosga-v03-*`（三片，含各自 review-report.md / ship-log.md）；父容器 `rasen/changes/mosga-v03/{planning-context.md,portfolio-run.json,handoff/}`
- 代码主面：`packages/ui/src/`（components/shell/、components/journey/、components/ui/、lib/）、`packages/daemon/src/{app.ts,publish.ts,cli.ts}`、`packages/publisher/src/{runner.ts,pr.ts}`
- 验证命令：`npm run typecheck`、`npm run build`、`npx vitest run --testTimeout=20000`（根目录）；启动 `npx mosga ui [--data-repo <path>]`
- Worker transcripts（本会话 c74be5df-*，跨会话后为死句柄，仅可 warm-seed）：planner-v03 / implementer-s1..s3 / reviewer-s1..s3 / shipper-s1，路径见 `C:\Users\Sayo\.claude\projects\E--AI-ChatAI-Agents-VibeCodingProjects-make-deepseek-great-again\c74be5df-223e-4172-ab7d-64ff592480ca\subagents\`

## Next action

启动 daemon 做 GUI 冒烟测试（`npm run build && npx mosga ui`，走完四步旅程含两出口），把结果记入 portfolio-run.json 的 humanFollowUps 第 1 条；若用户要开始 v0.4（建数据仓库 + CI + HF 同步），以 `rasen/office-hours/agent-session-data-contribution.md` Next Steps 6 为纲新开 portfolio。
