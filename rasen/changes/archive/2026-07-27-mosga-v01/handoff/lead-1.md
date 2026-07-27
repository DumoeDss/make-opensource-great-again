# Handoff: mosga-v01 — LEAD #1

> 项目 = **make-opensource-great-again** (MOSGA)，前身 make-deepseek-great-again。
> 目录名仍是 `...\make-deepseek-great-again`（用户不改本地目录，但 git 远端 + README 已改名为 make-opensource-great-again）。
> 远端：https://github.com/DumoeDss/make-opensource-great-again (origin main)。

## Original intent

用户受梁文锋（DeepSeek）"科技平权、反垄断"理念启发，要构建一个**会话脱敏导出工具 + 社区数据集**，让任何开发者能安全地把本地 AI 编程会话数据（如 Claude Code 的 `~/.claude/projects/**/*.jsonl`）贡献给开源社区。原话："把我们平时开发中的一些数据贡献给开源社区"。核心价值：真实的人机协作开发轨迹数据是开源模型生态最稀缺的东西。

用户最后一条指令："elftia版权没有问题，需要的代码直接拿出来用即可。开始实现吧。你来全权推进，不用停下，直到所有任务完成。"（预授权连续推进，各 gate 报告但不阻塞）。

权威设计文档（APPROVED，经 3 轮对抗评审 + 用户多轮修正）：`openspec/office-hours/agent-session-data-contribution.md`。

## Position

Pipeline: `auto-decompose`（LEAD 取了 decompose 分支，分成 4 个严格串行子变更）。
**状态：v0.1 portfolio 100% 完成。** 全部 4 个子变更已 shipped + archived 到 `main`，工作树干净。
父变更 `mosga-v01` 是无任务的规划容器，保留 active（`portfolio-run.json` 记录 frontier=[]、4 子全 done）——decompose 父容器子全归档后的常规状态。

## Done / Remaining

**Done（全部）**：
- `mosga-v01-readers` — monorepo 骨架 + `@mosga/contracts`(SCHEMA.md) + `@mosga/session-readers`(elftia 提取)。ship `e80b07b` / archive `5f2691b`。
- `mosga-v01-sanitizer` — `@mosga/sanitizer`：gitleaks v8.18.4 三层扫描 + 确定性化名 + ReDoS 防护。ship `7c98022` / archive `2daab6a`。
- `mosga-v01-review-ui` — `@mosga/daemon`(loopback 127.0.0.1:8899 + serve /ui) + `@mosga/ui`(React 审查门)。ship `57ecbc5` / archive `d5f0f0d`。
- `mosga-v01-publish` — `@mosga/publisher` + `templates/community-data-repo/`(CI 模板) + `INCIDENT-RESPONSE.md`。ship `01941e3` / archive `d5fde7e`（+ `902bb41` 补记归档 hash）。
- 12 个能力主 spec 已同步进 `openspec/specs/`。6 个包，143 vitest 测试全绿。端到端闭环打通：读取→扫描→人工门→导出→预检→PR-ready。

**Remaining（v0.1 无剩余；以下是发现的后续工作，均未开工）**：
1. **[推荐下一个变更] sanitizer 字段覆盖盲区**：`packages/sanitizer/src/scan.ts` 的 `collectScanUnits` 只遍历 `session.cwd/title` + 消息内容字段，**不扫 `meta.*` / `schemaVersion` / `session.{sessionId,sourceId,projectKey,updatedAt}`**。这意味着人工门（review-ui）也不会高亮藏在这些字段的密钥。publish 的**原始字节兜底扫描**（`packages/publisher/src/precheck.ts` 的 `scanRawBytesBackstop`）已堵死**发布路径**（数据出不去），所以非紧急泄漏风险；但为让人工门也能看见，应开后续变更扩宽 `collectScanUnits` 字段覆盖。**不要静默改已归档的切片——开新变更。**
2. 设计文档 Open Questions 里仍待用户拍板：schema 腹稿校准（SCHEMA.md 顶部标了"待发起人腹稿校准"）、数据集许可证、**ToS 分通道策略**（闭源模型输出的合规，出口①公开数据集 vs 出口② API 直投分别定）、重识别知情同意文案。
3. **出口② (API 直投重放，v0.2)**：设计已定，未实现。复用 `@omnicross/core` ApiConverter + `@omnicross/contracts` 31 provider 预设。见设计文档 Next Steps 7。
4. Tauri v2 桌面壳（v0.2+），照搬 omnicross 的 adopt-or-spawn daemon 模式。

## Key decisions (and why)

- **技术栈 TypeScript/Node ESM 全栈**（原设计文档写的 Python，复用评估后推翻）：可复用资产全在 TS 生态。npm workspaces monorepo，tsup 构建，vitest 测试，MIT 许可。
- **复用 elftia（GPLv3）代码以 MIT 重授权**：用户是版权人，已明确授权。会话发现/解析层逐字复用（`filesystem.ts`/`JsonlParser.ts`/`JsonlClaudeMeta.ts`/`encodeProjectPath`），只删 electron 依赖 + 换类型导入。每个复用文件带溯源 + MIT 重授权头。
- **复用 omnicross（MIT，npm 已发布）**：ApiConverter（v0.2 出口②）、31 provider 预设、daemon 架构形态。
- **脱敏检测器不自研**：vendored gitleaks v8.18.4 TOML 规则（173 条）；Go RE2 → JS 正则转译带兼容性校验，转不了的显式降级不静默丢弃。
- **化名映射**：会话内一致、跨会话不一致（防跨会话关联）。
- **非文本内容标记而非剥离**：⚠ 逐条人工确认（图片没有自动防线）。
- **确认门语义**：Layer 1/2 命中即阻断、未清零不解锁；Layer 3 统计 + 抽检；含图记录逐条确认。
- **本地预检 = CI 同一份规则集**：provenance 记录 `sanitizerPackageVersion`，CI pin 同一 package 版本（保证字节相同的引擎，不只是相同规则文本）。
- **社区收集用 GitHub PR 投稿**（非自建服务器）：零基建、审查链路公开可审计、CI 自动扫描即二次检查。
- **分解为 4 严格串行子变更**：相邻切片共享包接口 + monorepo config，无法证明独立性，保守串行不并行。

## Dead ends & gotchas

- **npm 不支持 `workspace:*` 协议**（EUNSUPPORTEDPROTOCOL）——包间依赖用 `"@mosga/contracts": "*"`（npm workspace-linking 形式）。
- **tsup 承担构建，per-package tsconfig 是 noEmit typecheck-only**（避免 paths/rootDir 冲突）。
- **Gitleaks 规则是 Go RE2 方言**：中置 `(?i)` inline flag 需 hoist 才能转 JS 正则（转译器已处理，把初始 19 条降级救回为忠实转译）。
- **RE2 线性时间保证在 JS 回溯引擎失效**：sanitizer 有 ReDoS 防护（250ms/字段 + 200k 上限 → 阻塞 needs-review finding）。EMAIL 正则曾灾难性回溯（200k 字段 59s），已 bound 量词修复。
- **daemon 必须有状态**：`applyDispositions` 需要 scan 时的同一个 PseudonymMapper 实例（内部 Map/counter 无法往返浏览器），daemon 按 reviewId 内存持有 `{session, report, mapper}`，重扫可确定性恢复。
- **scan-canary.mjs 不在 npm workspace 内**：从 `templates/community-data-repo/` 跑时需 `NODE_PATH` 指向 repo-root node_modules + `--preserve-symlinks`。
- **canary fixtures 含"看似密钥"的假值**（AKIAFAKEFAKEFAKE1234 等）+ vendor/gitleaks.toml 含规则正则——这些是**故意的**，ship 时 secret scan 别误报。

## Eliminated hypotheses

- **"elftia 解析器有个丢图片的 bug"** — 定性不准，别这么记。elftia 的 `parseContentBlocks`（`switch` 无 `default`）+ `extractToolResultContent`（非 text 块→`''`→`filter` 滤掉）确实把非文本块从文本视图摊掉，但那是**聊天渲染器的合理有损设计**（elftia 图片走另一条我们没复用的 `read()` 路径），在 elftia 语境里不是 bug。它只是与本项目"标记而非剥离 + 无声截断禁令"冲突，所以我们**不改 elftia**、加了 `parseClaudeSession` 标记 wrapper。**审查抓到的真 Blocker 是我们 wrapper 第一版的 bug**（只扫顶层、漏了 `tool_result.content[]` 嵌套的截图），已修复递归 + tool_use_id 定位。详见 planning-context.md 的 D5（精确版）与 `packages/session-readers/src/parseClaudeSession.ts`。
- **出口②"启动 code CLI 重放"** — 放弃改为 API 直发（`ApiConverter` 转格式后 POST 目标厂商 `/v1/messages`）。CLI 只是运载工具，直发链路更短、成本透明。
- **sanitizer entropy 用 gitleaks whole-match 语义** — 实测回归（generic-api-key 停用词含 "password" 会误杀 `password="<key>"` 真密钥），保留 group-1 语义（reviewer 正式撤回了自己的 m1 建议）。
- **publish 预检靠结构化 scan 覆盖全字段** — 被 PoC 证伪（meta/projectKey 未扫），改为**原始字节兜底扫描**（结构无关，覆盖 100% 发布字节，重叠 100k 窗口防边界骑跨）。

## Working set

- 工作树干净，全部已推送到 origin/main（HEAD = `902bb41`）。
- 运行状态：父 `openspec/changes/mosga-v01/portfolio-run.json`（authoritative，frontier=[]，4 子 done）+ `planning-context.md`（固化的跨切片契约，每切片一个"Planner findings"节）。各子变更的 `auto-run.json` 在其归档目录内。
- 审查报告：各归档子变更目录内的 `review-report.md` 记录了完整 finding 历史。
- 复用源（只读参考）：elftia `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`（GPLv3）、omnicross `...\elftia\elftia\omnicross`（MIT）。
- 构建/测试：`npm run typecheck` / `npm run build` / `npx vitest run`（143 测试）；publish CI 自测 `node templates/community-data-repo/scripts/scan-canary.mjs`。

## Gotcha: worker 中断

`impl-publish` subagent 在修 publish 最后一个 Major（M2b 版本校验）时触发 **monthly spend limit** 挂掉，留下红色测试套件。LEAD 接手补完（parity.ts 核心是它写的，M2b 回归测试 + fail-closed 脚本是 LEAD 补的），reviewer-publish（非作者）复审确认 CLEAN。**若继续派 subagent，可能需先在 claude.ai/settings/usage 提额。**

## Next action

v0.1 已完成，无阻塞。全新会话若要继续项目，最自然的下一步二选一：
1. 手动端到端验证：跑 `mosga ui`（`@mosga/daemon` 的 CLI）打开审查界面，用一个真实 Claude Code 会话走完 读取→扫描→人工门→导出→预检 全流程（office-hours 给用户的 Assignment）。
2. 开后续变更处理上面 Remaining #1（sanitizer 字段覆盖盲区）——`/opsx:new` 或 `/opsx:auto`，scope = 扩宽 `packages/sanitizer/src/scan.ts` `collectScanUnits` 覆盖 meta.*/session 标识字段 + 回归测试，勿改已归档切片。

先向用户确认要推进哪条（Remaining #2 的 schema/许可证/ToS 需要用户输入，不能自主决定）。
