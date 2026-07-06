# Planning Context — mosga-v01 (Make-OpenSource-Great-Again v0.1)

> LEAD 种子文档。planner 先读本文件与设计文档，只补研缺失信息，不要从零重新调研。

## 用户意图（原话要点）

- 项目初心：科技平权（梁文锋/DeepSeek 访谈）——把开发者本地的 AI 编程会话数据安全地贡献给开源社区。
- "elftia 版权没有问题，需要的代码直接拿出来用即可。开始实现吧。你来全权推进，不用停下，直到所有任务完成。"（2026-07-07，用户已确认 elftia 代码可以直接以 MIT 复用）
- 用户先前确认的架构：Node.js 后端 + React 前端（Tauri 壳推迟到 v0.2+）；直接引用 omnicross（npm 包）；复用 elftia 会话读取代码。

## 权威设计文档

`openspec/office-hours/agent-session-data-contribution.md`（Status: APPROVED，经 3 轮对抗评审 + 用户多轮修正）。所有 proposal 必须与它一致；冲突时以设计文档为准，除非本文件记录了更新的用户决定。

## v0.1 范围（来自设计文档 Next Steps）

双通道架构中的**出口①（HF 公开数据集通道）**：采集 → 脱敏 → 人工确认 → 导出/PR 投稿。出口②（API 直投）是 v0.2，本轮不做（但 schema 要作为两出口的共用中间格式设计）。

## Decompose 计划（LEAD 已定，4 个子变更，严格串行）

1. **mosga-v01-readers** — monorepo 骨架（npm workspaces + TypeScript ESM + tsup + vitest，模式照搬 omnicross）+ `@mosga/contracts`（zod 类型 + SCHEMA.md）+ `@mosga/session-readers`（从 elftia 提取的会话发现/解析层 + CliSourceAdapter 体系 + Claude Code adapter）。
2. **mosga-v01-sanitizer** — `@mosga/sanitizer`：Gitleaks 规则摄取（TOML 解析 + Go RE2→JS 正则转译校验）、用户自定义规则、三层扫描（密钥/自定义/归一化）、会话内一致确定性化名映射、结构感知遍历、审查报告生成、非文本内容标记（不剥离）。
3. **mosga-v01-review-ui** — `@mosga/daemon`（本地 HTTP API + 自 serve `/ui`，模式照搬 omnicross daemon）+ `@mosga/ui`（React 18 + Vite + Tailwind 审查界面：命中枚举、逐项处置、按类型/规则一键批量替换、⚠含图记录逐条预览、分层确认签署、未清零不解锁导出）。
4. **mosga-v01-publish** — `@mosga/publisher`：统一 schema 导出、本地强制预检（与 CI 共享三层规则集，不通过拒绝生成 PR）、GitHub PR 投稿流、社区数据仓库模板（CI workflow + 金丝雀密钥测试 + HF 同步脚本）、泄漏应急预案文档（INCIDENT-RESPONSE.md）。

依赖 DAG：readers → sanitizer → review-ui → publish（严格串行；后一个消费前一个的包接口）。

## 已确立的调研结论（不要重新探索）

### elftia 可复用代码（GPLv3，但用户为版权人，已授权直接以 MIT 复用）

Base: `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia\packages\desktop\app\main\services\`

- `routers/legacy/filesystem.ts` — `scanClaudeProjectDirs()`(:27)、`listSessionFilesInProject()`(:51)、`readSessionEntries()`(:67)、`extractSummaryFromEntries`/`extractCwdFromEntries`/`probeProjectCwd`(:87/:103/:119)。纯 Node，零 Electron/DB 耦合。
- `routers/legacy/parsers/JsonlParser.ts` — `deduplicateEntries()`(:55, 按 uuid 取最新)、`parseContentBlocks()`(:104, text/thinking/tool_use/tool_result)、`parseJsonlEntriesToAgentMessages()`(:182, 主入口)。
- `routers/legacy/parsers/JsonlClaudeMeta.ts` — Claude meta（local-command、toolUseResult 摘要）。
- `routers/legacy/types.ts` — `JsonlEntry`(:6)、`ContentBlock`(:54)、`ParsedAgentMessage`(:73)。注意含 `isSidechain`（子代理）、`isCompactSummary`、`isMeta`、`toolUseResult` 字段。
- `agent-core/engine/cli/native-reader/claudeProjectsPaths.ts` — `encodeProjectPath()`(:23)：非字母数字→`-`，不折叠不裁剪。有一处 `electron` 依赖（app.getPath('home')），但有 `process.env.USERPROFILE/HOME` 回退——提取时删掉 electron 分支即可。
- `native-reader/ClaudeNativeTranscriptReader.ts` — 用 `parseToMessages()`(:151) 路径（干净）；不要用 `read()`（耦合 elftia 显示层 IR）。
- `native-reader/CodexNativeTranscriptReader.ts` + `codexPathResolver.ts` + `codexRolloutParser.ts` — Codex 读取器（`~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`，支持 .zst）。v0.1 只做 Claude Code，Codex/Cursor 读取器留到 v1.x，但 adapter 接口要为其预留。
- `capabilities/code-cli/sources/adapters/claudeCodeAdapter.ts` + `sources/types.ts`（`CliSourceAdapter` 接口：`locateRoots/listProjects/listSessions/resolveTranscriptPath/read/parseTranscriptToMessages`）+ `CliSourcesService.ts` + `registry.ts` — 多 CLI 可插拔编排的设计模板。
- 共享 Zod 契约：`packages/shared/src/contracts/api/cliSources.ts`（`CliSessionRefSchema` = `{sourceId,projectKey,id,path,title,cwd,updatedAt,sizeBytes}`）。

### omnicross 可复用资产（MIT，npm 已发布）

Repo: `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`

- `@omnicross/core` — `ApiConverter.ts`（`convertAnthropicRequestToOpenAI` 等，纯函数含流式）。v0.2 出口②用；v0.1 不需要。
- `@omnicross/contracts` — 31 个 provider 预设（`packages/contracts/src/provider-presets/presets/*.json`）。v0.2 用。
- daemon 架构参考：Admin API 于 `127.0.0.1:8766`，UI 通过 HTTP 与 daemon 通信（非 invoke），daemon 自 serve `/ui` 零 CORS；monorepo 布局 packages/{contracts,core,daemon,ui}，tsup 构建，vitest 测试。**@mosga/daemon 照这个形态做，但端口用别的（如 8899）避免冲突。**
- omnicross 中没有任何 JSONL 会话读取/脱敏/重放代码——不重叠。

### 关键工程决策（已定，勿反悔）

- TypeScript/Node ESM 全栈；npm workspaces monorepo；MIT 许可证。
- Gitleaks 规则是 Go RE2 方言：摄取时做转译 + 兼容性校验（转不了的规则显式列出并降级为字面量/简化正则，不能静默丢弃——设计文档"无声截断"禁令）。
- 化名映射：会话内一致、跨会话不一致。
- 非文本内容：标记 ⚠ 不剥离，人工逐条确认。
- Layer 1/2 命中即阻断，未清零不解锁；Layer 3 统计 + 抽检。
- 本地预检与 CI 共享同一份三层规则集。
- 白名单范围选择是专有代码防线：默认只推荐公开 git remote 的项目。

### Schema 假设（待用户校准）

用户自称有数据集 schema 腹稿但未提供细节（设计文档 Open Question 1）。planner 在 mosga-v01-readers 中设计 SCHEMA.md 时：以"脱敏后的 Claude Code 会话 JSONL 超集 + 顶层 meta（贡献者化名、工具版本、脱敏规则集版本、时间戳、许可证声明）"为 v0.1 中间格式，保持与原始 JSONL 结构同构（出口②重放需要），导出层再做数据集切片。**在 SCHEMA.md 顶部标注"待发起人腹稿校准"。**

## 工程约束

- 平台 Windows（开发机），但代码必须跨平台（路径处理用 node:path，home 目录用 os.homedir()）。
- 仓库根即 monorepo 根；现有内容：LICENSE(MIT)、README.md、openspec/。
- 每个子变更必须留下可运行的测试（vitest）；脱敏引擎必须有金丝雀密钥测试样例（用假密钥）。
- 不要提交任何真实会话数据到仓库；测试 fixture 一律手工构造假数据。

## Planner findings — readers (append-only)

> mosga-v01-readers planner 定下的、siblings 必须遵守的固定事实。改动需走协调式版本升级，勿静默漂移。

### 包边界（omnicross 式 contracts/core 拆分）

- `@mosga/contracts`（`packages/contracts/`）：纯 schema/type，零 I/O，唯一运行时依赖 `zod`。持有：reader 引用、`ParsedMessage`、`ToolCall`/role 原子类型、`SanitizedSession` 信封、`SCHEMA.md`。
- `@mosga/session-readers`（`packages/session-readers/`）：依赖 contracts，持有全部 FS + 解析 + adapter 逻辑。
- 后续包（siblings 建）：`@mosga/sanitizer`(slice2) 消费 `ParsedMessage[]`/信封；`@mosga/daemon`+`@mosga/ui`(slice3)、`@mosga/publisher`(slice4) 消费 contracts。

### 固定接口名

- `CliSourceAdapter`（精简版，仅枚举+元数据+解析委托）：`id`、`displayName`、`locateRoots(home)`、`listProjects(roots)`、`listSessions(roots, project)`、`resolveTranscriptPath(ref)`、`parseTranscriptToMessages(path)`。**砍掉** elftia 的 `read`（显示 IR）、memory、subagent、continue、`resolveTranscriptPathById`、`registryBackendId`。
- registry：`getAdapter(id)` / `listAdapters()`；v0.1 只注册 `claudeCodeAdapter`。
- 非文本标记入口：`parseClaudeSession(transcriptPath)` —— 薄 wrapper，复用解析路径逐字不改 + 额外扫原始 entry 标记非文本块。
- 复用逐字保留：`readSessionEntries`/`deduplicateEntries`/`parseJsonlEntriesToAgentMessages`/`parseContentBlocks`/`JsonlClaudeMeta` 三函数/`encodeProjectPath`。**只走 `parseToMessages` 干净路径，不碰 elftia 的 `read()`（耦合显示层 IR）。**

### 关键工程决定（siblings 勿反悔）

- D2：不依赖 elftia `@shared/chat-types`；`role`(`user|assistant|system`) 与 `ToolCall`(`{id,name,input,status:'completed'|'error',result?}`) 在 `@mosga/contracts` 本地重定义。
- D3：electron 依赖仅 `claudeProjectsPaths.ts` 的 `app.getPath('home')`；`encodeProjectPath` 本身无 electron。提取时删 electron，home 用 `os.homedir()||USERPROFILE||HOME`。
- D5：elftia 解析器**静默丢弃** image/非文本块（渲染器无所谓，本项目禁止——设计文档"标记而非剥离"+"无声截断禁令"）。mosga 必须在 wrapper 里标记非文本块。**slice3 的 ⚠ 逐条预览 UI 依赖这个标记。** 是否保留非文本块原始字节（vs 仅"存在+类型"标记）留给 slice3 定义预览需求时决定，当前倾向仅标记。

### SanitizedSession 信封字段清单（load-bearing schema，`schemaVersion` 版本化）

```
schemaVersion: string                          // 如 "0.1.0"
meta:
  contributorAlias: string                     // 会话内确定性贡献者化名
  sourceCli: enum("claude-code", ...)          // 可扩展；v0.1 仅 claude-code
  toolVersion: string
  sanitizationRulesetVersion: string | null    // readers 出为 null；sanitizer(slice2) 盖章
  exportedAt: string (ISO-8601)
  license: string | null                       // Open Q2 待定
  sanitized: boolean                           // readers 出为 false；脱敏门后 true
session:
  sessionId, sourceId, projectKey,
  cwd: string | null                           // readers 出原始；slice2 归一化/化名
  title: string | null, updatedAt: number
messages: ParsedMessage[]                       // 与源 JSONL 同构（出口②重放需要）
```

- `ParsedMessage`（`ParsedAgentMessage` 超集）：必填 `{sdkUuid,parentUuid,role,content,sdkMessageType,timestamp}` + 可选 `toolCalls/toolResults/thinking/isSidechain/commandName/commandMessage/commandArgs` + 非文本标记。
- `CliProjectRef` = `{sourceId,key,cwd:nullable,label}`；`CliSessionRef` = `{sourceId,projectKey,id,path,title:nullable,cwd:nullable,updatedAt,sizeBytes}`（去掉 elftia 的 `startedInElftia`）。
- readers 产出信封恒为 `sanitized:false` + `sanitizationRulesetVersion:null`；`SCHEMA.md` 顶部 banner "待发起人腹稿校准"。

### 排除的死路

- 不复用 elftia `read()`/`ChatMessagePage`/`buildInMemoryEventRows`/`AgentEventDisplayProjection`/`claudeSubagentScan`——纯显示层，导出管道无用。
- 不拉 elftia `@shared` 包当依赖（非 MIT-clean-scoped，且远超所需两个类型）。
- 不 fork 改 `parseContentBlocks` 加标记——会把 mosga 关注点缠进复用码，阻碍未来 elftia 再同步；改用外层 wrapper。
- slice1 不做 CI/lint gate（slice4）、不 npm publish、不做 Codex/Cursor adapter 实现（接口预留，v1.x 实现）。

## Planner findings — sanitizer (append-only)

> mosga-v01-sanitizer planner 定下的、slices 3-4 必须遵守的固定事实。report 模型 / ruleset 文件格式 / apply API 是跨切片契约。

### 包 + 依赖

- 新包 `@mosga/sanitizer`（`packages/sanitizer/`），依赖 `@mosga/contracts` + `@mosga/session-readers`。新 dep：`smol-toml`（gitleaks TOML 解析，ESM）、`zod`。运行时零网络（gitleaks 配置 vendored）。
- **决策 D1（可能被 lead 推翻）**：report/rule 的 zod schema 放在 `@mosga/sanitizer` 内导出，slices 3/4 用 `import type` 零运行时拉入；slice4 CI 因需真跑扫描而运行时依赖引擎。未放进 `@mosga/contracts` 的原因：readers 未 archive，`openspec/specs/` 空，无法对 session-contracts 发 MODIFIED delta；且 lead 把范围划在 sanitizer 包。若团队后续想把 report 类型上提到 contracts，是干净重构。

### 固定接口名（slices 3-4 honor）

- 三层：`Layer = 'secrets' | 'custom' | 'normalization'`（L1/L2/L3）。L1/L2 `blocking:true`，L3 `blocking:false`。
- `Disposition = 'pending' | 'replace' | 'delete' | 'allow'`（默认 pending）；`NonTextItem.disposition = 'pending' | 'keep' | 'remove'`。
- `FindingLocation`：`{ scope:'message'|'session', messageIndex?, messageUuid?(=sdkUuid), field, toolCallId?, toolResultIndex?, span:{start,end} }`；`field ∈ content|thinking|commandName|commandMessage|commandArgs|toolCallInput|toolCallResult|toolResultContent|sessionCwd|sessionTitle`。span 是**该字段解析后字符串内**的偏移（toolCallInput 是 canonical JSON 序列化后的偏移）。
- `Finding`：`{ id(稳定 hash，跨 re-scan 保留 disposition), layer, ruleId, category?(L3:path|username|email|ipv4|ipv6), location, matchPreview(secret 脱敏，绝不存原文), replacementSuggestion, disposition, blocking }`。
- `SanitizationReport`：`{ reportVersion, sanitizationRulesetVersion, sessionId, generatedAt, findings[], layerSummary{secrets{total,pending},custom{...},normalization{total,byCategory}}, nonTextItems[], gate{blockingTotal,blockingPending,nonTextPending,unlocked} }`。
- Gate 语义：`unlocked = blockingPending===0 && nonTextPending===0`；**L3 不参与 gate**（设计文档：L3 统计+抽检，非逐项阻断）。gate 是纯函数；"未清零不解锁" 的 UI 强制在 slice3、导出强制在 slice4。
- Apply API：`applyDispositions(session, report, mapper) -> SanitizedSession`（不原地改）；支持 `batch-by-rule` / `batch-by-type`；blocking 未清零不产出 `meta.sanitized:true`。
- `PseudonymMapper`：`map(category, original) -> placeholder`（`<PATH_1>`…），首次遇到顺序分配，**会话内一致、跨会话不一致**（顺序分配天然实现），session-scoped 不跨会话持久化。primary username 的 placeholder 同时填 `meta.contributorAlias`。

### Ruleset 工件（slice4 CI 消费同一份）

- gitleaks `gitleaks.toml` **vendored + pin tag**，绝不运行时 fetch。
- 编译工件 JSON：`{ rulesetVersion(复合id: gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>), gitleaksVersion, generatedAt, rules[], degraded[] }`。tool 与 slice4 CI 加载**同一份**→本地预检与 CI 复扫规则完全一致。`rulesetVersion` 盖进 report 与 sanitized 信封，CI 校验版本对齐。
- RE2→JS：翻译 + 兼容校验；每条规则终态 `native|translated|degraded|disabled`，非 native 全部进 `degraded[]` 清单附原因；**规则数守恒**（`native+translated+degraded+disabled == TOML 总数`），绝不静默丢弃（设计文档禁令）。degrade 阶梯：无法翻译→降级 keyword/literal 匹配（有 keyword 时，仍 block-on-hit）→否则 `disabled` 附原因。
- 保真机制（控假阳）：keyword 预过滤 + entropy/secretGroup 阈值 + allowlist（regexes/stopwords）。`allowlist.paths/commits` 对会话扫描 N/A，忽略但**文档记录**（非静默）。

### 结构感知扫描目标（ParsedMessage 真实字段）

- 逐消息：`content`、`thinking`、`commandName/Message/Args`、`toolCalls[].input`(canonical 序列化后扫)、**`toolCalls[].result`**、`toolResults[].content`；逐会话：`cwd`、`title`。system role 的 `content` 即"系统提示"高危位。
- **非文本关键**：readers 的 post-review fix 使 `nonTextContent` 标记可能落在 **tool_use 承载的 assistant 消息**上（tool_result 里嵌的截图经 tool_use_id 解析过去），不只在直觉上的 user 消息。sanitizer 必须遍历**所有**消息的 `nonTextContent`。sanitizer 不剥离非文本，只把标记转成 `NonTextItem` 逐条人工确认。

### 风险处置（已入 design）

- RE2 线性保证在 JS 回溯引擎丢失→ReDoS：per-field 扫描超时/大字段分块，超时降级为 needs-review finding（偏向 recall，不静默跳过）。
- report 持久化不得含原始 secret：`matchPreview` 脱敏，原文只在内存 apply 过程存在。

### slice2 排除

- 不做 review UI/daemon/gate 强制 UX（slice3）；不做 publish/PR/CI workflow 文件（slice4，但编译工件格式须 CI 可加载）；不做导出 schema 切片；不做 Presidio/LLM PII 层（推迟）；不改 slice1 已发布源码（只消费）。
