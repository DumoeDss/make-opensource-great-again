# mosga-v03 Planning Context（持久 planner 种子，LEAD 维护）

> ⚠ 工具链（2026-07-09 更新）：CLI 为本地 fork **rasen**，一切 `openspec <cmd>` 替换为：
> `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`
> **根目录已从 `openspec/` 迁移为 `rasen/`**（migrate copy-only 已执行）。一切变更产物写 `rasen/changes/<name>/`；`openspec/` 目录为冻结遗留，**只读，勿写勿删**。禁止全局安装官方 @fission-ai/openspec。

## User intent（逐字要点，2026-07-09）

"现在来优化前端页面显示，当前的前端只能说有个功能，不管是实用性还是美观程度都非常的差，让人没有用下去的欲望。omnicross的那种前端设计（设计风格有些偏向claude）就挺好的" → 经 office-hours 会话定稿为范围 C（视觉系统 + 流程重构 + 补齐 HF 发布流程）。随后 `/opsx:auto auto-decompose no gate，你来推进执行所有任务`——**用户预授权连续推进：gates 报告但不阻塞**（与 v01/v02 相同模式）。

## 权威设计文档（planner 必读，实现以此为准）

`rasen/office-hours/frontend-ui-redesign.md`（Status: APPROVED，3 轮对抗性评审 22 项修复，9/10）。
线框图：`rasen/office-hours/frontend-ui-redesign-wireframe.html`（3 屏：处置工作区/签署卡/双出口）。
本文件只做摘要，**细节冲突时以设计文档为准**；设计文档已含：B1 设计系统层 / B2 应用外壳 / B3 四步旅程 / B4 daemon publish 路由（含错误分类、stage 状态模型、异步 CommandRunner 要求、`compareUrl` 派生）/ Later 清单 / Open Questions（带建议，非阻塞）。

## Decompose 计划（严格串行，3 子变更，对应设计文档实施切片）

守恒策略：三片全部触碰 `packages/ui`，无正向独立性证明 → 全串行。

1. **`mosga-v03-ui-design-system`**（纯前端，无行为变化）
   - 从 omnicross（`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`，MIT，只读参考）按文件级移植：`packages/ui/src/index.css` 的 `:root`/`.dark` 语义令牌 + tailwind.config 扩展（colors/fontFamily/fontSize/borderRadius）+ 组件基元（button/badge/dialog/confirm-dialog/input/select/switch/tooltip 起步，cva 变体）+ `cn` util。
   - 新依赖：`class-variance-authority`、`lucide-react`、`clsx`、`tailwind-merge`。
   - emoji 状态图标（🔒🔓⚠）全部换 lucide（strokeWidth 1.5）；字体 Inter 栈 + Georgia display + mono 栈（不捆绑字体文件）。
   - 现有 9 组件套用新令牌重刷但**不改结构、不改行为**；现有 4 个测试文件必须全绿（断言若绑定旧样式类名可调整断言，行为契约不动）。
2. **`mosga-v03-ui-journey-shell`**（前端结构重构，依赖切片 1）
   - NavRail 外壳（贡献/设置两项 + daemon 状态页脚）+ 常驻步骤条（①选会话→②处置→③签署→④出口）+ 锁徽章四态（还差N/已解锁/已签署/已完成）。
   - ②处置工作区：blocking/nontext/L3 三 tab 合并为左分组导航 + 右处置队列；批量操作提升为建议卡；「归一化统计」只读不计数。
   - ③签署卡（清零后浮现，Georgia 标题 + 处置统计摘要 + checkbox + 签署按钮）；签署为客户端态，刷新失效、改处置作废并重锁④。
   - ④双出口卡（出口① 占位为"就绪状态卡"，向导在切片 3 实装）+ 出口② SubmitPanel 语义全保留改卡片 + 「仅导出脱敏文件」次要动作 + 回执视图（④ 完成态）。
   - JSON 全部收进「高级」折叠。处置/gate/409 语义零变化。
3. **`mosga-v03-publish-exit-one`**（前后端，依赖切片 2）
   - daemon：`POST /api/reviews/:id/publish/plan|stage|submit` + `GET /api/publish/preflight`（`{dataRepoConfigured,gitAvailable,ghAvailable,ghAuthenticated,repoClean}`）+ 启动配置 `dataRepoPath`（信任侧，永不经 HTTP 写入；设置页只读展示）。
   - 错误分类对标现有 `/submit`：`precheck_refused`（规则聚合）/`repo_dirty`/`branch_exists`（确定性分支重试碰撞，附处置指引）/`gh_unauthenticated`/`push_rejected`。
   - **异步 CommandRunner**：publisher 现有 runner 是同步的——需加异步变体或 worker 线程卸载（显式任务，同步接口保留供 CLI/测试）；单 in-flight publish 互斥锁。
   - stage 状态模型：内存 per-review `staged` 标志 + 分支名；首 stage 遇 branch_exists = 残留分支，给指引不自动清理。
   - plan 路由返回 UI 安全子集（字段清单见设计文档 B4，含派生 `compareUrl`，排除 record 字节）。
   - UI：出口① 三步向导（预检 pending/超时态 → PR 预览 → 提交/gh-free 兜底展示落盘位置+命令+compareUrl）。
   - 最大隐藏工作量 = daemon 改写用户本地 git clone 的错误面；预算按"错误路径 ≈ 快乐路径"。

## 背景（v0.1/v0.2 已全部归档）

- 现有 8 包：`@mosga/contracts`/`session-readers`/`sanitizer`/`daemon`/`ui`/`publisher`/`direct-submit` + `apps/desktop`（Tauri 壳）。npm workspaces + tsup + vitest；包间依赖写 `"*"`。
- UI 现状：React 18 + Vite + Tailwind 3（配置全默认），9 组件约 1.1k LOC，入口 `packages/ui/src/App.tsx`；daemon REST 客户端 `packages/ui/src/api/client.ts`（可注入测试）。
- daemon 路由注册在 `packages/daemon/src/app.ts`；静态 serve `packages/daemon/src/staticUi.ts`；Tauri 壳 `apps/desktop`（frontendDist 指向 splash，daemon serve `/ui`）。
- publisher 接口：`planContribution`/`stageContribution`/`submitContribution`/`PublishRefusedError`（`packages/publisher/src/pr.ts`）；同步 `CommandRunner` 在 `runner.ts`。
- **禁止修改已归档产物（rasen/changes/archive/** 与 openspec/** 全部）。**

## Gotchas（worker 必读）

- npm 不支持 `workspace:*` → 包间依赖 `"*"`；tsup 构建，per-package tsconfig 是 noEmit typecheck-only。
- UI 测试用 @testing-library/react + jsdom；`vitest` 从仓库根跑。
- omnicross 引用为**只读**，复制文件时保留其注释风格；MIT 无归属障碍。
- E 盘空间紧张（v02 遗留问题）——大构建物勿落 E 盘临时目录。
- Tauri 壳的 CSP 锁 connect-src 到 loopback——新增路由同源无影响，但若引入外部字体/CDN 会被 CSP 拦（设计已决定不捆绑外部资源）。

## 切片 1（ui-design-system）planner 决策记录（2026-07-09，已 propose + strict validate 通过）

- **新增 capability `ui-design-system`**（非 MODIFIED `review-ui`）：表现层需求单独立 capability，`review-ui` 行为规格 + 4 测试契约保持不动 = 零行为变化的规格编码。4 产物 strict validate 通过。
- **`dialog`/`confirm-dialog` 推迟到切片 2**：二者依赖 `@radix-ui/react-dialog`（不在本切片批准的 4 个新依赖 cva/lucide-react/clsx/tailwind-merge 内），且切片 1 无任何组件用到 dialog；其真实消费点是切片 2 的「改处置作废重锁」确认。**切片 2 planner 需把 radix 加入依赖并移植这两个基元**。切片 1 起步基元 = 6 个无 radix 的（button/badge/input/select/switch/tooltip）。
- **`@`→`src` 别名**：切片 1 在 `packages/ui/{vite.config.ts,tsconfig.json}` + 根 `vitest.config.ts` 三处装好（因 omnicross 基元用 `@/...` 导入，切片 2/3 会移植大量此类文件，一次装好复用）。别名由「typecheck+build+vitest 三跑」终验守护。切片 2/3 直接受益。
- **`cn` 用 clsx + tailwind-merge**（非 omnicross 的零依赖版），置 `src/lib/cn.ts`；移植基元的 `@/shared/utils/utils` 导入改写为 `@/lib/cn`。tailwind-merge 锁 v2（v3 面向 TW4）。
- **原生控件切片 1 保持原生**：现有 `<select>`/`<input type=checkbox>` 换成自定义 Select/Switch 会破坏以 HTMLSelectElement/HTMLInputElement + `.disabled`/`.checked` 查询的测试；切片 1 只用令牌类重刷原生元素，自定义 Select/Switch/Input/Tooltip 仅作库供切片 2/3。仅 Button/Badge 无结构风险地代入现有标记。
- **深色模式**：切片 1 装 `src/lib/theme.ts` 跟随系统 bootstrap（toggle `.dark` class，非 CSS `@media`——因切片 2 三态开关要靠 class 覆盖系统偏好，class 必须是唯一真源）。bootstrap 在 `main.tsx`，不在 4 测试文件导入图内。**切片 2 设置页三态开关取代它**（Open Question 1 建议采纳）。
- **测试契约冻结点**（切片 2/3 restyle 也须守）：全部 `data-testid`、gate 文案 `Gate locked`/`Gate unlocked`（注意 `unlocked` 含子串 `locked`，断言用 contains）、Picker h1 `Select a session to review`、`matchPreview` 只显脱敏值。4 测试文件今天不断言样式类名，理论上重刷零改测试。
- **fontSize 令牌会全局缩小正文**（base 0.875rem）= omnicross 密度，刻意为之；页标题 `xl`/`2xl` 仍走 TW 默认。
- **ExportPreview/SubmitPanel 的裸 `<pre>` JSON 切片 1 只重新着色保留**——其降级进「高级」折叠是切片 2 的信息架构工作（成功标准「界面不再有裸 pre JSON 作主载体」由切片 2 兑现）。

## 切片 2（ui-journey-shell）planner 决策记录（2026-07-09，已 propose + strict validate 通过）

- **规格结构 = 新 capability `ui-journey-shell`(ADDED) + `review-ui`(MODIFIED 4 条)**：新外壳/步骤条/工作区/签署卡/出口卡/设置页进新 cap；`review-ui` 中呈现被重定义的 4 条（Gate banner→锁徽章+签署卡；Export preview→摘要+高级折叠；Render-and-gate 与 Cheap-tests 两条因文案提到 "gate banner" 也一并 MODIFY）行为场景保留、只改呈现措辞。MODIFIED 靠 header 精确匹配——**header 保持原样不改**（"Gate banner…" 标题不动，正文改为锁徽章+签署卡），body 承载真相。切片 3 若再改 review-ui 呈现须循此法。
- **`ReviewView` 变旅程容器**（建议保留文件名减少 churn；若重命名 JourneyView 须改 App.tsx import）。持有 report/signed/busy/error/exported，派生当前步 + 锁徽章态，渲染 Stepper + ②DispositionWorkspace/③SigningCard/④ExitCards，取代 5-tab + GateBanner。
- **`GateBanner` 溶解**（删文件）：逻辑拆进 Stepper 锁徽章 + SigningCard；`SIGNED_SUMMARY` 常量搬去 SigningCard/共享常量。GateBanner.test 替换为 SigningCard.test（+Stepper 测试），同契约新组件表达——这是 lead 批准的"结构性测试重组"。
- **签署作废规则加严**：今 `run()` 仅在 gate 重锁时丢签名；新规则（设计 B3③）= 已签署后**任何**处置变更都作废签名 + 重锁④，用 **ConfirmDialog 守卫**（取消=不调 daemon；确认=作废+执行）。守卫**仅 `signed` 为真时拦截**——未签署时处置走原直调路径，保住现有 disposition 测试契约。
- **dialog/confirm-dialog 移植（radix）真实消费点 = 上面的作废守卫**。加 `@radix-ui/react-dialog ^1.1.2`。`dialog.tsx` 剥 `wallpaper-solid`（留 bg-surface-0），`confirm-dialog.tsx` 已纯令牌。**不装 tailwindcss-animate**——`animate-*` 类留着惰性（弹窗功能正常），切片 3 视需要再定。
- **主题三态化**：`lib/theme.ts` 从"仅跟随系统" 扩为 `light|dark|system` + localStorage 持久 + system 订阅 `prefers-color-scheme`（切片 1 行为成为 system 默认）。设置页开关驱动之。取代切片 1 的 follow-system bootstrap（Open Question 1 结论落地）。
- **切片 2 零 daemon 改动**：设置页 = 主题 + daemon 健康(`/api/health` 经新增 client `getHealth()` + `useDaemonStatus`) + 只读 provider 列表(`/api/providers`)。**数据仓库路径展示 + preflight provider-key 状态推迟到切片 3**（其端点尚不存在）。出口① 仅"就绪态占位卡"，无 publish 调用。
- **Badge span 修复**（切片 1 reviewer Minor）：Badge 从 `<div>` 改渲染 `<span>`（类型 HTMLSpanElement），使其在 Picker `<button>` 内合法嵌套；视觉不变。**切片 3 planner 注意**：Badge 现为 span。
- **client `getHealth()` 加法安全**：测试 fakeClient/emptyClient 用 `as ApiClient` 强转，缺方法仍编译；顺手补进 stub。
- **切片 3 接口衔接**：出口① 卡槽已由 ExitCards 建好（就绪态占位）；切片 3 只需把 3 步向导塞入该卡 + 加 daemon publish 路由/preflight/dataRepoPath。dialog/confirm-dialog 已可用。设置页已在，切片 3 往里加数据仓库路径只读行 + preflight 四态。
