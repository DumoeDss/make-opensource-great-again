# mosga-v02 Planning Context（持久 planner 种子，LEAD 维护）

> ⚠ 工具链：本项目 OpenSpec CLI 已改为本地 fork **rasen**。一切 `openspec <cmd>` 均替换为：
> `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`
> 禁止全局安装官方 @fission-ai/openspec（功能不一致）。

## User intent（逐字要点，2026-07-09）

用户选定 v0.2 范围 = **"两个都做"**：出口②（API 直投重放）在前，Tauri v2 桌面壳在后，串行推进。沿用 v0.1 预授权模式：gates 报告但不阻塞，连续推进到全部完成。

**用户已拍板（勿再询问）——出口② ToS 合规策略（设计文档 Open Question #3）**：
"知情同意 + 完整保留"——出口②保留完整会话（含 assistant 消息，重放必需），工具内明示 ToS 风险，用户知情确认后才能投递。此决策需落入 direct-submit 切片的 spec/design，并回写 `openspec/office-hours/agent-session-data-contribution.md` Open Questions #3（标注已决策 + 日期 2026-07-09）。

## 背景（v0.1 已完成，全部归档）

- 权威设计文档：`openspec/office-hours/agent-session-data-contribution.md`（Next Steps 7 = 出口②）。
- v0.1 交接：`openspec/changes/mosga-v01/handoff/lead-1.md`；跨切片契约：`openspec/changes/mosga-v01/planning-context.md`（信封 schema、包接口、决策 D1-D5 全在这里，planner 必读）。
- 现有 6 包：`@mosga/contracts` / `session-readers` / `sanitizer` / `daemon` / `ui` / `publisher`；npm workspaces + tsup + vitest（143 测试）；包间依赖写 `"*"`（npm 不支持 `workspace:*`）。
- **禁止修改已归档的 v0.1 切片产物（openspec/changes/archive/**）；改代码走新变更正常改。**

## Decompose 计划（严格串行，3 子变更）

守恒策略与 v0.1 相同：相邻切片共享 monorepo config + `@mosga/contracts`，无正向独立性证明 → 全串行。

1. **`mosga-v02-sanitizer-coverage`**（小，先做）
   - Scope：扩宽 `packages/sanitizer/src/scan.ts` `collectScanUnits` 覆盖 `meta.*`、`schemaVersion`、`session.{sessionId,sourceId,projectKey,updatedAt}` 等当前不扫的信封字段 + 回归测试（fixture 在这些字段埋密钥，断言 finding 产出且 review-ui 数据流可见）。
   - Why first：出口②是**新的数据出口**。出口①有 publisher 的原始字节兜底扫描堵死发布路径，出口②发送前也要有对等兜底（见切片 2），但人工门看不见这些字段的命中始终是缺口——在开新出口前先补上，安全叙事才自洽。
   - 注意：化名/替换语义是否对这些字段生效需 planner 调查（projectKey/sessionId 可能需要哈希化名而非文本替换）；`sanitizerPackageVersion` 等 provenance 字段本身不应被误脱敏。
2. **`mosga-v02-direct-submit`**（出口②主体）
   - Task 1 硬性要求（设计文档 Next Steps 7）：**token 成本估算先行**——多轮重放成本随轮数近似平方增长，给出典型会话（按 v0.1 真实会话长度分布取样）在代表性厂商定价下的成本表，写入 design.md；若成本不可接受需给出截断/摘要策略选项再继续。
   - 实现：新包（建议 `@mosga/direct-submit` 或 `@mosga/replayer`，planner 定名）复用 `@omnicross/core` ApiConverter（Anthropic↔OpenAI 含流式）+ `@omnicross/contracts` 31 provider 预设；脱敏会话直接 POST 目标厂商 `/v1/messages` 或转 OpenAI 格式打 `/chat/completions`；**不启动 code CLI**。
   - 目标站点用户可自行添加，官方提供开源模型厂商预设（DeepSeek 等），全部用用户自己的 key（env/本地配置，key 永不入导出数据）。
   - **知情同意门（用户已拍板）**：投递前工具内明示 ToS 风险 + 完整保留语义，用户确认后才发送；确认记录落 provenance。
   - **发送前兜底**：对等复刻 publisher 的原始字节兜底扫描（`packages/publisher/src/precheck.ts` 的 `scanRawBytesBackstop` 模式）——出口②发送的每个字节同样过兜底，Layer 1/2 命中即阻断。
   - meta 消息：重放时附带的贡献元信息消息（设计文档腹稿），格式 planner 定义进 contracts。
   - 回写设计文档 Open Questions #3 决策标注。
3. **`mosga-v02-tauri-shell`**（桌面壳）
   - Scope：Tauri v2 壳包裹现有 `@mosga/daemon` + `@mosga/ui`，照搬 omnicross 的 **adopt-or-spawn daemon** 模式（复用源只读：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`，MIT）。
   - 依赖切片 2：壳要包住含出口②投递 UI 的最终界面，且 daemon 端点集合在切片 2 后才稳定。
   - 注意 Windows 构建链（Rust toolchain）可用性需 planner 先探测；不可用则该切片提前 escalate 而不是硬撞。

## 复用源（只读参考）

- omnicross：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`（MIT，npm 已发布，可直接依赖 npm 包 `@omnicross/core` / `@omnicross/contracts`——planner 核实 npm 包名与版本）。
- elftia：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`（GPLv3，v0.1 已完成需要的提取，v0.2 预计不再动它）。

## Gotchas（继承自 v0.1，worker 必读）

- npm 不支持 `workspace:*` → 包间依赖 `"*"`。
- tsup 构建；per-package tsconfig 是 noEmit typecheck-only。
- canary fixtures 与 vendor/gitleaks.toml 含故意的假密钥/规则正则，ship 时 secret scan 勿误报。
- ReDoS 防护：sanitizer 有 250ms/字段 + 200k 上限；新增扫描字段同样过这层。
- daemon 有状态：`applyDispositions` 依赖 scan 时同一 PseudonymMapper 实例（按 reviewId 内存持有）。
- 上次 impl subagent 曾因 monthly spend limit 中断——worker 挂掉时 LEAD 接手补完 + 非作者复审。

## Planner findings（planner 逐切片追加，durable 结论 only）

### slice 1: sanitizer-coverage

> 本切片提案已产出并通过 rasen validate（含 --strict）。产物：`openspec/changes/mosga-v02-sanitizer-coverage/{proposal,design,tasks}.md` + `specs/sanitization-scan/spec.md`(1 MODIFIED + 2 ADDED) + `specs/sanitization-apply/spec.md`(2 ADDED)。以下是 siblings 需知的固定结论。

**根因/范围（已核实）**：`collectScanUnits`（`packages/sanitizer/src/scan.ts:45`）只扫 message 体 + `session.cwd/title`，漏 `schemaVersion`、`meta.*`、`session.{sessionId,sourceId,projectKey,updatedAt}`。该缺口已被 publisher 的 `scanRawBytesBackstop`（`packages/publisher/src/precheck.ts` 的 finding **B1**）在**发布路径**兜住，但人工 review gate（daemon `POST /api/reviews` → `scanSession` → UI 渲染 `report.findings`）看不见——出口②无兜底前必须先补人工门覆盖。

**FindingField 契约扩展（additive，slice 2/3 需知）**：`FindingFieldSchema`（`schemas.ts`）新增 10 个 session-scope 值：`schemaVersion,metaContributorAlias,metaSourceCli,metaToolVersion,metaExportedAt,metaLicense,sessionId,sessionSourceId,sessionProjectKey,sessionUpdatedAt`。纯追加、非破坏；UI `describeLocation`（`packages/ui/src/lib/findings.ts:23`）已泛化处理 session scope（`session.<field>`），无需改 UI。`@mosga/ui`/`@mosga/publisher` 以 `import type` 拉入，additive 不破坏。

**字段语义决策（design.md 权威表）**：
- `session.projectKey` = 高风险（`encodeProjectPath` 把绝对路径非字母数字→`-`，内嵌 OS 用户名+项目目录名，如 `-Users-alice-acme`）。斜杠锚定的 L3 `PATH_RE/USERNAME_RE` 打不中破折号形式。→ **字段级**识别 encoded home-path slug（仅对 projectKey unit，绝不对任意正文），命中发一条 **non-blocking L3 `path`** finding 覆盖整 slug，用会话 mapper 的 `<PATH_n>`。**复用现有 `path` 分类，不新增 `NormalizationCategory`**（避免 enum 波及 UI/publisher）。与 cwd 完全对称。
- `session.sessionId` = 低 PII（UUID）→ 仅 L1/L2 block-only，**不化名**（化名会破坏 publisher 确定性文件名 `data/…/<sessionId>.jsonl`，且 UUID 非 PII）。可写只为让"埋入的密钥"可被 replace。
- provenance/tool-controlled（`schemaVersion,meta.sourceCli/toolVersion/exportedAt/license,session.sourceId`）= 扫（block-only 防御纵深）+ 可写（避免 no-op 泄漏），但**绝不自动改写**：仅在人工显式 replace/delete 真命中时才编辑，正常流零 finding→字节不变。
- `meta.sanitizationRulesetVersion`+`meta.contributorAlias` = **stamp 权威写**（gate-unlock 时 apply 盖章），不算 sanitization，stamp 覆盖任何 disposition。
- 非字符串跳过：`meta.sanitized`(bool)、`meta.sanitizationRulesetVersion`(scan 时 null)。`session.updatedAt`(number) 用 `String()` 强转扫（block-only），无 writer。

**"不得脱敏"的 provenance（回答 LEAD 提问）**：`sanitizerPackageVersion` **不是** `SanitizedSession` 字段——它在 publisher `EngineInfo` stamp（`precheck.ts`），发布时从 `@mosga/sanitizer` package.json 取，本切片从不扫/改。安全因为它是社区 CI pin 的引擎身份，改它会破坏 parity。

**关键不变式（勿反悔）**：(1) 不动 publisher 的 `scanRawBytesBackstop`——它仍是字节级最后防线，也是非字符串字段的唯一覆盖；(2) ReDoS 防护（250ms/字段 + 200k cap + `redos-guard` finding）对新字段**自动生效**，因走同一 per-`ScanUnit` 循环；(3) apply 可写但非自动改写——省掉了 UI 侧 acknowledge-only 改造（本可选，未做，留作 UI polish）。

**slice 2（direct-submit）继承点**：出口②发送前的对等兜底应复刻 `scanRawBytesBackstop` 模式（字节级、无 allow 逃生口）；人工门覆盖已由本切片补齐，两出口共享同一 review gate 语义。
