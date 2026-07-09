# codex-session-reader Planning Context（planner 种子，LEAD 维护）

> ⚠ 工具链：CLI 为本地 fork **rasen**，一切 `openspec <cmd>` 替换为：
> `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`
> 产物写 `rasen/changes/codex-session-reader/`；`openspec/` 目录冻结只读。禁止全局安装官方 @fission-ai/openspec。

## User intent（逐字，2026-07-09）

"当前仅支持ClaudeCode数据的读取，你再去扩展codex等codecli的数据的读取，可以参考elftia读取codecli数据的代码：E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia"

管线：small-feature（用户显式指定）。核心 = 给 `@mosga/session-readers` 增加 **codex 源适配器**；"等codecli"读作：codex 是本片必做的具体交付，同时确认 registry seam 对后续 CLI（Cursor 等）保持开放（seam 本来就开放，无需为未来 CLI 写代码）。

## LEAD 已做的侦察（planner 从这里接力，勿重复）

### mosga 侧现状

- `packages/session-readers/src/adapter/types.ts`：`CliSourceAdapter` 接口（id/displayName/locateRoots/listProjects/listSessions/resolveTranscriptPath/parseTranscriptToMessages）。**该接口就是从 elftia 的 adapter 接口裁剪来的**（设计 D4：只留枚举+元数据+干净 parse delegate；elftia 的 read/resolveTranscriptPathById/memory/subagent/continue/registryBackendId 全部是死面，勿引入）。
- `packages/session-readers/src/adapter/claudeCodeAdapter.ts`：唯一现有 adapter，结构范本（truncateTitle/safeTitle/枚举永不 throw）。
- `packages/session-readers/src/adapter/registry.ts`：`getAdapter`/`listAdapters` 注册表；daemon `app.ts` 的 `/api/sources*` 路由全部经 registry 分发 → **新增 adapter 后 daemon/UI 零改动**（UI Picker 从 `/api/sources` 动态取源列表——需 planner 确认 Picker 是否硬编码 claude-code）。
- 解析目标类型：`@mosga/contracts` 的 `ParsedMessage`（现有 `parseClaudeSession.ts` = JsonlParser + non-text marker 包装）。非文本内容（图像等）在 parse 层打 marker，供 sanitizer 的 nonTextItems 门禁 — **codex parser 也必须遵守此契约**（含图 turn 要产出 non-text marker，不能静默丢弃）。
- 测试范本：`__tests__/adapter.test.ts`（temp-dir 纯 FS）、`registry.fake-adapter.test.ts`、`parse-layer.test.ts`、`non-text-marker.test.ts`。npm workspaces、包间依赖写 `"*"`、vitest 从仓库根跑。

### elftia 参考代码（MIT，只读参考；路径根 = E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia）

- **codex adapter**：`packages/desktop/app/main/services/capabilities/code-cli/sources/adapters/codexAdapter.ts` — 已通读，要点：
  - roots = `~/.codex/sessions`；rollout 文件 `rollout-<ISO-ts>-<uuid>.jsonl[.zst]` 按 `<YYYY>/<MM>/<DD>` 日期树组织（MAX_WALK_DEPTH=8 有界递归）。
  - 项目分组 = 各 rollout 首行 `session_meta.cwd` 去重；无 cwd → 合成 `(unknown)` 项目。listProjects/listSessions 共用一次 `scanCodexRollouts()` 扫描结果。
  - 每文件只读有界前缀（128KB/60 行）取 `session_meta`(id/cwd) + 首条真实 user `input_text`（跳过 `<environment_context>`/`<user_instructions>` 脚手架）作 title；文件名尾部 UUID 作 id 兜底。
  - `.jsonl.zst` 枚举时不解压（filename uuid + null cwd/title）；elftia 的 reader 打开时才懒解压。**mosga 决策点：v0.x 是否支持 .zst？**（elftia 用 zstd 依赖懒解压；mosga 可选择枚举时跳过 .zst 或列出但 parse 返回 []，避免新增原生依赖 — planner 决策并写入 design）。
  - 单测范本：`adapters/__tests__/codexAdapter.test.ts`。
- **codex 转写解析**：elftia 委托 `CodexNativeTranscriptReader.parseToMessages`（`packages/desktop/app/main/agent-core/engine/cli/native-reader/CodexNativeTranscriptReader.ts`）— planner 需通读它，把 codex rollout 行格式（`type:"response_item"` + payload.type message/reasoning/function_call/function_call_output 等）映射到 mosga `ParsedMessage`。注意 mosga 只要干净 parse（role/text/非文本 marker），不要 elftia 的 display-IR。

## 约束与决策已定项

- 新 adapter 文件放 `packages/session-readers/src/adapter/codexAdapter.ts`，parser 放 `packages/session-readers/src/`（命名对齐现有 `parseClaudeSession.ts`，如 `parseCodexSession.ts`）；registry 注册 + index.ts 导出。
- 枚举纯 FS 只读、永不 throw、方法接 roots 参数（temp-dir 可测）— 与现有 adapter 同纪律。
- **规格结构建议**：session-readers 已有 capability（archive 里查既有 spec 名，MODIFIED 时 scenario 标题逐字不改——rasen archive 按标题匹配，改标题=归档拒绝）；新增 codex 支持可作 ADDED requirement 或新 capability，planner 按主 spec 现状定。
- 验证命令：`npm run typecheck`、`npm run build`、`npx vitest run --testTimeout=20000`（仓库根）。当前 219 测试全绿，不得回归。
- E 盘空间紧张，勿在 E 盘落大临时物；omnicross/elftia 均只读参考。

## Open questions（planner 在 proposal/design 给结论）

1. `.jsonl.zst` 处理策略（建议：本片跳过 .zst 或列出但标注不可解析，不引 zstd 原生依赖；留 Later）。
2. "(unknown)" 项目在 mosga UI 的呈现（Picker 直接显示即可？whitelist.ts annotateProject 对 codex cwd 的 recommended 判定是否适用）。
3. codex rollout 中的非文本内容形态（图像 input？）与 non-text marker 映射。

## Planner 追加（proposal 完成，2026-07-09）

### Open questions 的结论

1. **`.zst` 策略（已定）**：recognize but skip at enumeration，parser 对 `.zst` 路径返回 `[]`。不引 zstd/wasm 依赖。理由：与 claude adapter「跳过无 `.jsonl` 的目录」同一 degrade-cleanly 纪律；比「列出但空 parse」更好（不给用户一个导出为空字节的会话）。Later = 加 zstd 解码器再枚举+解析。
2. **`(unknown)` 项目呈现（已定，零改动）**：`daemon/whitelist.ts` 的 `annotateProject` 纯粹按 `project.cwd` 探 git remote，source-agnostic。codex 真实 cwd 被同样 git 探测；`(unknown)` 项目 `cwd:null` → 走 `!project.cwd` 分支返回 not-recommended（reason "no working directory to probe"）。**无需改 whitelist。**
3. **非文本映射（已定）**：codex `message` 内容 part 里 `type` 非 `input_text`(user)/`output_text`(assistant) 的（如 `input_image`）→ 在该 message 上打 `nonTextContent.blockTypes`。`reasoning.summary`、tool 输出（stdout 字符串）是文本通道，不标。

### 关键设计决策

- **D1（重要，偏离 claude 模式）**：claude 用 `parseClaudeSession.ts` 薄包装 + 按 `uuid` 关联外部 re-scan 打 marker，因为 `JsonlParser` 逐字复用。**codex rollout item 无稳定 per-item id**（elftia parser 每条 `randomUUID()`、file order），外部 re-scan 无法可靠关联 → codex parser **采用式移植**（types 改指 `@mosga/contracts`），marker 在单趟里 **inline** 打。这是有意的、已记档的偏离。
- **规格结构（已定）**：`session-readers` 是 MODIFIED capability。1 个 MODIFIED（"Claude Code adapter enumeration" 去掉 "v0.1 ships ONLY this adapter" 假陈述，2 个 scenario 标题逐字保留）+ 2 个 ADDED requirement（"Codex adapter enumeration"、"Codex transcript parsing to the shared message form"，后者含 image-part non-text marker scenario）。**不新建 capability。**
- **文件布局**：`adapter/codexAdapter.ts`（枚举+delegate）、`parseCodexSession.ts`（入口，`.zst`→`[]`）、`parsers/codexRollout.ts`（行映射+inline marker）、`parsers/codexToolNormalize.ts`（normalize+envelope unwrap，逐字移植）。

### 必须注意的回归点（load-bearing）

- **`__tests__/registry.fake-adapter.test.ts:32-35` 硬断言 `listAdapters().map(id) toEqual(['claude-code'])`**。注册 codex 后必然失败 → tasks 5.3 已列：改为 `['claude-code', 'codex']`。这是注册动作触及的唯一既有测试。

### elftia 参考文件的**规范路径**（canonical，非 worktree 副本）

- reader：`…/elftia/elftia/elftia/packages/desktop/app/main/services/agent-core/engine/cli/native-reader/CodexNativeTranscriptReader.ts`（委托 `codexRolloutParser.ts` + `codexToolNormalize.ts`，均在同目录）。planning-context 原写的 `agent-core/engine/cli/native-reader` 路径缺了 `services/` 段——正确根是 `…/services/agent-core/…`。
- adapter：`…/services/capabilities/code-cli/sources/adapters/codexAdapter.ts`（+ `__tests__/codexAdapter.test.ts`）。
- 注意 elftia 有多个 worktree 副本（`elftia-wt-*`、`elftia-branch/*`）；只读规范副本 `elftia/elftia/elftia/…`。

### 验证状态

`rasen validate codex-session-reader --strict` → **valid**。status 4/4 artifacts complete。
