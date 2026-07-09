# settings-provider-management Planning Context（LEAD 种子，planner 必读）

> ⚠ 工具链：CLI 为本地 fork **rasen**，一切 `openspec <cmd>` 替换为：
> `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" <cmd>`
> 产物写 `rasen/changes/settings-provider-management/`；`openspec/` 目录冻结只读。禁止全局安装官方 openspec。

## User intent（逐字，2026-07-09）

"我看整个设置页面都还是只读状态，没法直接使用，现在是不是先把这一部分缺口补上？先让流程能够完整走完？另外投放目标先只加DeepSeek/z.ai/智谱 GLM/Kimi (Moonshot)/MiniMax/小米 MiMo 这几项，因为只有这些是开源模型的源提供商，不需要添加非开源Provider以及中转Provider。然后提供添加自定义Provider（支持多种api格式，openai completion/response/anthropic/gemini）"

拆解为三个诉求：
1. **设置页从只读变可用**，让出口②直投流程端到端走通（当前无 key 配置入口 = 流程根本无法完成）。
2. **预置投放目标收窄为 6 家开源模型源厂商**：DeepSeek / z.ai / 智谱 GLM / Kimi (Moonshot) / MiniMax / 小米 MiMo。排除非开源厂商（OpenAI/Anthropic/Gemini/Grok…）与中转厂商（OpenRouter/SiliconFlow/Together…）。
3. **支持添加自定义 Provider**，apiFormat 多格式：openai (chat completions) / openai-response (Responses API) / anthropic / gemini。

## LEAD 勘察结果（已核实，勿重复研究）

### 现状：provider 列表全量透传 29 个 omnicross 预置

- `packages/direct-submit/src/providers.ts` 的 `listProviders()` = `getAllProviderPresets()`（来自 npm 依赖 `@omnicross/contracts@^0.1.2`，装的是 0.1.3）全量 + userTargets。当前设置页/SubmitPanel 会看到全部 29 个预置，包括用户明确不要的（openai/anthropic/gemini/grok/azure/openrouter/siliconflow/together/perplexity/volcengine/dashscope/tencent/baidu/kuaishou/mthreads/ollama/groq/cerebras/mistral…）。
- **与用户 6 家对应的预置 id**（`node -e "import('@omnicross/contracts').then(m=>...getAllProviderPresets...)"` 实测）：
  - DeepSeek → `deepseek`（openai 格式）
  - z.ai → `zhipu`（name "z.ai"，openai 格式，base `https://api.z.ai/api/paas/v4`）
  - 智谱 GLM → `zhipu-bigmodel`（openai 格式，base `https://open.bigmodel.cn/api/paas/v4`）
  - Kimi (Moonshot) → `kimi`（openai 格式）
  - MiniMax → `minimax`（**anthropic 格式**，base `https://api.minimaxi.com/anthropic`）
  - 小米 MiMo → `xiaomi-mimo`（openai）与 `xiaomi-mimo-anthropic`（anthropic）**两个预置**——planner 决定收一个还是两个（建议两个都收，同厂不同端点，或只收一个并说明理由）。
- 收窄手段建议：direct-submit 层加**允许清单常量**过滤预置（勿改 omnicross 包）；`resolveProvider` 同步过滤，否则 UI 隐藏但 API 仍可提交到未列出的预置（一致性/安全面）。

### 现状：UserTarget 有类型无入口（死代码级缺口）

- `UserTarget`（id/name/apiFormat/apiBaseUrl/models，**永不含 key**）经 `AppOptions.userTargets` 注入，但 `packages/daemon/src/cli.ts` **没有任何对应 flag**，实际用户无法配置。设置页 (`packages/ui/src/components/SettingsPage.tsx`) 仅只读列表。
- 自定义 Provider 需要：持久化（建议 `~/.mosga/` 下 JSON，daemon 启动加载 + HTTP CRUD 写回）+ daemon 路由（zod 校验）+ 设置页表单（增删改，格式下拉四选一）。持久化文件路径本身不经 HTTP 写入。

### 现状：key 无法配置 = 出口② 流程无法完成（最核心缺口）

- `resolveProviderKey`（`packages/direct-submit/src/keys.ts`）：env `MOSGA_PROVIDER_KEY_<ID>` → env 通用 → `providerKeyConfigPath` JSON 文件。但 cli.ts **也没有 `--provider-keys` flag**，env 是唯一实际可用路径——普通用户等于没法用。
- **信任模型张力（planner 必须显式设计，这是本变更最大的设计决策）**：v0.x 既有纪律是 "providerKeyConfigPath 仅启动配置、永不经 HTTP 写入/回显"（与 dataRepoPath 同模式）。用户诉求"设置页直接可用"意味着 key 要能从 UI 录入。建议方向（planner 可推翻但须论证）：
  - daemon 侧新增用户级 key 存储文件（如 `~/.mosga/provider-keys.json`），HTTP **只写不读**：POST 设置/DELETE 删除；GET 只返回 `{providerId: configured:boolean}`，**任何响应永不回显 key 字节**。
  - 这是对既有纪律的**有意放宽**，依赖 loopback-only + Host 白名单（app.ts `isLoopbackHost` DNS-rebinding 防线已有）。设计文档必须写清威胁模型变化与不变量（key 只进 outbound auth header；明文落盘于用户目录须在 UI 上明示）。
  - 既有 env / `providerKeyConfigPath` 优先级链保留（resolveProviderKey 的 precedence 决定新文件排第几）。

### 现状：apiFormat 转换只有 anthropic 原生 + openai 一条岔路

- `packages/direct-submit/src/reconstruct.ts` 组装原生 Anthropic 请求；`providers.ts` 的 `isAnthropicFormat()`：anthropic 发原生，**其余一律转 OpenAI chat completions**。
- 用户要的自定义 Provider 四格式中 **gemini 与 openai-response 目前没有转换路径**（omnicross 预置里 `gemini` 的 apiFormat 是 `"google"`——命名对齐要注意）。
- **好消息**：已有依赖 `@omnicross/core@^0.1.2` 就带转换器：`convertMessageToGemini` / `convertMessageToOpenAI` / `buildGeminiApiUrl` / `buildOpenAIResponseApiUrl` / `convertAnthropicRequestToOpenAI` 等（实测 exports）。planner 应优先评估复用 omnicross 转换器而非手写（与 v03 "勿重新发明"决策一致），但要核对其输入形状是否匹配 mosga 的 AnthropicChatRequest 组装结果，以及 usage 解析（transport.ts `parseUsage` 目前只认 anthropic/openai 两种 usage 形状，gemini 的 usageMetadata 不在内）。
- 6 家预置全是 openai/anthropic 格式，**gemini/openai-response 仅自定义 Provider 需要**——若复用成本高，可论证砍格式，但用户逐字点名了四格式，砍需过 gate 时明示。

### 相关既有面（改动落点）

- `packages/direct-submit/src/{providers,keys,submit,reconstruct,transport,estimate}.ts`
- `packages/daemon/src/{app.ts(AppOptions+路由注册),cli.ts(新 flag?),publish.ts(参考错误分类风格)}`
- `packages/ui/src/components/{SettingsPage,SubmitPanel}.tsx`、`packages/ui/src/api/{client,types}.ts`
- 测试：根目录 `npx vitest run --testTimeout=20000`（现 219 全绿）；daemon 测试注入 fake（submitTransport 模式）；UI 测试 @testing-library/react。

## 约束与 gotcha（v03 沿袭，worker 必读）

- **测试契约冻结**：现有 data-testid、gate 文案 `Gate locked`/`Gate unlocked`（断言用 contains）、Picker h1 等勿动；SubmitPanel 语义（成本估算、双重知情确认、consent 绑定 contentHash）零变化——只加 provider 来源，不改提交语义。
- **安全不变量**：key 永不进任何 daemon 响应/日志/receipt；`/api/providers` 保持 key-free；自定义 Provider 的 baseUrl 是用户自己填的出站目标（loopback 单用户威胁模型下可接受，但 zod 至少校验 http(s) URL 形状）。
- npm 不支持 `workspace:*`（包间依赖写 `"*"`）；tsup 构建；per-package tsconfig 是 noEmit typecheck-only。
- **rasen archive 按 scenario 标题逐字匹配**：MODIFIED 既有 requirement 时 scenario 标题必须与主 spec 逐字一致，只改 WHEN/THEN 正文；新增 scenario 不受限。
- 禁改 `rasen/changes/archive/**` 与 `openspec/**`；omnicross 引用只读（其 npm 包按依赖用，勿 fork 勿改 node_modules）。
- E 盘空间紧张，大构建物勿落 E 盘临时目录；Tauri CSP 禁外部资源。
- 现有主 specs 里相关 capability：`review-ui`、`ui-journey-shell`、`direct-submit`（或近名，planner 用 `rasen list` 核对）——设置页改动大概率 MODIFIED `ui-journey-shell` 的设置页条目 + direct-submit capability 的 provider 条目；新 key 管理可能值得新 capability。

## Open questions（planner 在设计中给出结论，gate 时报给用户）

1. key 经 HTTP 只写录入是否采纳？（LEAD 建议采纳，写清威胁模型；否则流程仍走不通）
2. xiaomi-mimo 收一个还是两个预置？minimax 仅 anthropic 端点，确认无碍。
3. gemini / openai-response 转换复用 @omnicross/core 还是自写最小实现？usage 解析如何补？
4. 自定义 Provider 持久化文件位置与格式（建议 `~/.mosga/user-providers.json`）；与 `AppOptions.userTargets`（测试注入）的合并语义。

## Planner 决策记录（2026-07-09，propose 阶段）

产物：`proposal.md` / `design.md` / `specs/{direct-submit,provider-management,ui-journey-shell}/spec.md` / `tasks.md`，`validate --strict` 通过。

**能力划分**：direct-submit（收窄 + 转换核心，2 个 MODIFIED requirement）、provider-management（新能力：daemon 持久化 + 自定义 Provider CRUD 路由 + key 只写路由）、ui-journey-shell（设置页 requirement MODIFIED，3 个既有 scenario 标题逐字保留）。

**四个 open question 的结论：**

1. **key HTTP 只写 = 采纳（design D2）**。新用户级文件 `~/.mosga/provider-keys.json`（0600），`PUT/DELETE /api/provider-keys/:id` 写/删，`GET /api/provider-keys` 只返回 `{id:{configured:boolean}}`，任何响应/日志/receipt 永不回显 key 字节。`resolveProviderKey` 优先级链把 store 放最后：per-provider env → 通用 env → 启动 `keyConfigPath` → store（显式服务端配置永远压过 UI 录入，保住既有不变量）。威胁模型放宽已在 design.md 写清：这是 daemon 首个 HTTP 可写密钥面，靠 loopback+Host 白名单 + 只写 + status-only-boolean + 0600 + UI 明文落盘告知来承接。

2. **xiaomi-mimo 收两个预置**（`xiaomi-mimo` openai + `xiaomi-mimo-anthropic` anthropic）。同厂两官方端点，格式覆盖最大化、零额外风险。允许清单共 **7 个 preset id 覆盖 6 家厂商**。minimax 仅 anthropic 端点，确认无碍。

3. **转换：复用 @omnicross/core + 缺失处写薄封装（design D4）**。实测 core 有 `convertAnthropicRequestToOpenAI`（整请求）+ 消息级 `convertMessageToGemini`/`convertMessageToOpenAI` + `buildGeminiApiUrl`/`buildOpenAIResponseApiUrl`，但**没有** Anthropic→Gemini / Anthropic→Responses 的整请求转换器。方案：`serializeOutbound` 改四路 switch。openai-response 复用 openai 转换结果再 remap `messages→input`、`max_tokens→max_output_tokens`（usage 已是 input_tokens/output_tokens，parseUsage 无需改）。gemini 用 `convertMessageToGemini` 逐条拼 `contents[]`+`systemInstruction`+`generationConfig`，auth 用 `x-goog-api-key`，**parseUsage 必须新增 `usageMetadata`（promptTokenCount/candidatesTokenCount）解析**。四格式全部经 `foldThinkingIntoText`（anthropic 除外）与 pre-send backstop。用户逐字点名四格式故不砍。

4. **自定义 Provider 持久化 = `~/.mosga/user-providers.json`（UserTarget 数组，永不含 key）**。启动加载进内存缓存，CRUD 改缓存+原子写回（temp+rename）。与 `AppOptions.userTargets` 合并语义：**注入的 userTargets 在前、文件持久化在后，按 id 去重、注入优先**——保证既有 daemon 测试（注入 userTargets）确定性不变。自定义 Provider 不受预置允许清单约束（走 resolveProvider 的 userTargets 分支，恒可解析）。新增 daemon 模块 `providerStore.ts` 统管两文件，可注入内存 fake 供测试。

**新增落点补充**：cli.ts 加 `--user-providers` / `--provider-keys` flag（默认 `~/.mosga/...`），经 server.ts 透传 createApp。新路由：`GET/POST /api/custom-providers`、`PUT/DELETE /api/custom-providers/:id`、`GET /api/provider-keys`、`PUT/DELETE /api/provider-keys/:providerId`。`/api/providers` 载荷收窄为允许清单（行为性 BREAKING，预期）。

**冻结项确认未动**：SubmitPanel 提交语义、backstop、所有 data-testid / gate 文案、219 绿测试；`provider-list` testid 保留。

### 补充决策（propose gate 用户反馈后，2026-07-09）：key 存储改为加密落盘（移植 omnicross SecretBox）

用户在 gate 追问：为何 key 存明文 JSON 而不复用 omnicross 的密钥存储。LEAD 核实并采纳——**放弃明文文件，改为加密落盘**，与 v03「从 omnicross 文件级移植、勿重造」先例一致。

- omnicross secrets 三模块（`envelope.ts`/`masterKey.ts`/`SecretBox.ts`，MIT 同作者）**未在 `@omnicross/core`/`@omnicross/contracts` npm 包导出**，整包依赖 `@omnicross/daemon` 不可接受 → **文件级复制**进 `packages/daemon/src/secrets/`，仅重命名常量。
- 信封格式 `enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>`，AES-256-GCM，每次加密新随机 12B IV + 16B tag；错误 key/篡改 → GCM 认证失败 → 可操作、无秘密泄漏的报错。
- 主密钥链（重命名）：`MOSGA_MASTER_KEY` env（64 hex 或 base64→32B，永不落盘）→ keyfile `~/.mosga/master.key`（0600，**故意与 key store/config 分离**，复制 config 不会带走主钥）→ 首次加密用时惰性 `randomBytes(32)` 生成写 0600。惰性：纯明文/`$ENV` 直通路径不触发 keyfile 写入。
- `~/.mosga/provider-keys.json` 形状不变 `{providerId: value}`，但每个 value 过 `SecretBox`：写时 `encryptMaybe`（UI 录入的 key 一律存 `enc:` 信封）、读时 `decryptMaybe`（`$ENV` 间接引用与 legacy 明文仍可解析，明文下次写入时升级为密文）。原子写（temp+rename）。
- `resolveProviderKey` 优先级链不变，store 仍排最后（读经 `decryptMaybe`）：per-provider env → 通用 env → 启动 keyConfigPath → store。
- **威胁模型措辞更新**：加密落盘防的是**意外泄露**（备份/配置共享/密钥扫描器只见密文），**不防**同用户本地攻击者（能同时读 keyfile 并解密）——与 omnicross design D8 同款诚实 caveat；Windows 下 `chmod 0600` best-effort（NTFS ACL 不映射 POSIX mode），写入仍成功。严格优于原先明文的 `providerKeyConfigPath`。
- 新增 CLI flag：`--master-key-file <path>`（连同 `--user-providers`/`--provider-keys`）。

产物同步更新：design.md D2（+Non-Goals/Risks 两处）、`specs/provider-management/spec.md`（key 需求改名为「…with encryption at rest」，新增两条 scenario：加密落盘、`$ENV`/legacy 直通）、`specs/ui-journey-shell/spec.md`（明文→加密披露措辞）、proposal.md、tasks.md（新增第 3 节移植任务，key store 任务改走 SecretBox，章节重编号 3→9）。`validate --strict` 复跑通过。
