# MOSGA API 直投：CLI 续跑与真实请求投递完整方案

日期：2026-07-27
状态：方案已收敛，待转为正式 change / implementation design
范围：MOSGA 出口②（API 直投）
核心目标：请求真实性（request authenticity）

## 1. 结论

MOSGA 的 API 直投不应继续把规范化后的 `messages` 直接拼成厂商 API 请求。

正确路径是：

1. 从原始 Claude Code / Codex session 生成保持原生格式的脱敏副本；
2. 同时准备 CLI 恢复 session 所需的脱敏项目指令上下文；
3. 在隔离的临时运行环境中拉起原始来源 CLI；
4. 通过 CLI 的 resume / continue 能力恢复脱敏 session；
5. 注入一次性本地代理地址和路由凭据；
6. 让 CLI 发送唯一新增的一条 terminal meta message；
7. 由 CLI 在运行时组装 System Prompt、工具定义、skill 描述和环境上下文；
8. 本地代理只负责路由、真实上游凭据隔离、必要的协议转换、单次请求控制与回执；
9. 代理阶段暂不再次扫描或改写 prompt。

一句话概括：

> MOSGA 不再伪造一个“看起来像 CLI 会话”的 API 请求，而是让来源 CLI 基于脱敏后的原生 session，真正生成并发出这次请求。

现有 direct API 路径可以保留为明确标注的兼容模式，但不能再被称为“真实 CLI session continuation”，也不能在 CLI 续跑失败时静默降级使用。

## 2. 为什么要改变当前直投方式

当前链路大致是：

```text
原始 session
    │
    ▼
reader / parser
    │
    ▼
ParsedMessage[]
    │
    ▼
SanitizedSession.messages
    │
    ▼
MOSGA 重建厂商 API body
    │
    ▼
目标模型
```

这条链路的问题不只是“少了一些 metadata”，而是重建请求所需的关键上下文本来就不全部存在于 session 文件中。

Claude Code / Codex 在运行时还会组装：

- System Prompt；
- CLI 自身的行为约束；
- 工具定义及工具使用规则；
- 当前运行模式；
- sandbox / approval / collaboration 等运行策略；
- 环境说明；
- `CLAUDE.md` / `AGENTS.md` 等项目指令；
- 当前可用 skills 的描述；
- 与 CLI 版本、目标模型和配置有关的动态内容。

其中一部分可能在 session 中留下痕迹，但不能假定它们完整、稳定或能够由 MOSGA 正确重建。

因此，直接用 `messages` 调厂商 API 只能保证“消息记录被发送”，不能保证“发送的是来源 CLI 会生成的请求”。

## 3. 请求真实性的精确定义

本方案追求的“请求真实性”是：

> 目标请求由原始来源 CLI 在恢复脱敏 session 后实际组装和发出；MOSGA 不自行仿制该 CLI 的 System Prompt、工具 schema 或上下文装配逻辑。

它不等同于：

- 对历史请求做字节级复现；
- 保证使用与历史完全相同的 CLI build；
- 保证 CLI 当前版本的 System Prompt 与历史版本完全一致；
- 保证目标厂商收到与 CLI 原始协议完全相同的 JSON 字节；
- 保证超出 context window 的全部历史都进入最终请求；
- 保证厂商一定把请求用于训练。

跨厂商投递时，代理可能必须做 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 等协议之间的转换。因此更准确的定义是：

- **CLI-origin authenticity**：请求语义由来源 CLI 生成；
- **transport fidelity**：代理尽量保持语义不变，只做目标厂商要求的协议转换；
- **wire identity**：仅在目标端原生支持 CLI 输出协议时才可能接近字节级一致。

MOSGA vNext 以第一项为硬目标，以第二项为代理约束，不承诺第三项。

## 4. 已确认的设计决策

### 4.1 使用来源 CLI，而不是由 MOSGA 重建 System Prompt

- Claude Code session 由 Claude Code 恢复；
- Codex session 由 Codex CLI 恢复；
- 不尝试维护一份 Claude Code / Codex System Prompt 的 MOSGA 副本；
- 不把 terminal metadata 冒充为 system message。

### 4.2 保持 session 的来源原生格式

用于续跑的产物不能只包含规范化后的 `ParsedMessage[]`。

应对来源 JSONL 做结构保持型脱敏：

- 保留来源 CLI 能识别的 row type；
- 保留消息顺序；
- 保留 session、turn、parent、tool-call 等结构引用；
- 保留恢复所需的原生 metadata；
- 只替换或删除明确需要脱敏的内容；
- 避免因为重新序列化为统一消息 schema 而丢失未知字段。

统一的 `SanitizedSession` 仍可用于 UI、预览和公共数据集导出，但它不再是 CLI 直投续跑的唯一数据源。

### 4.3 `CLAUDE.md` / `AGENTS.md` 属于运行上下文，不属于普通 metadata

这类文件不会可靠地包含在 session JSONL 中，但会影响 CLI 生成请求。

因此 ReplayBundle 需要携带经过脱敏和人工确认的“有效项目指令快照”，并按 CLI 可识别的相对位置放入隔离运行目录。

默认不挂载完整原项目，也不把整个工作区复制进续跑环境。

### 4.4 skills 由 CLI 处理

MOSGA 不解析、不重建、也不把完整 skill body 手工注入请求。

运行时由 CLI 自己完成 skill discovery。初始请求通常只加载 skill description；完整 skill body 只有在 CLI 实际调用该 skill 时才会被读取。

本方案的约束是：

- ReplayBundle 不序列化 skill body；
- 允许 CLI 按其原生规则发现配置的 skill roots；
- skill roots 以只读方式暴露给隔离运行环境；
- terminal meta 明确要求只返回短 ACK；
- 一次性代理路由最多允许一次模型推理请求；
- 即使模型意外请求调用 skill，也不允许继续发起第二次推理。

因此，正常链路不会为了投递而主动加载完整 skill body。

需要明确的剩余风险是：CLI 首次请求中自动加入的 skill description 属于运行时上下文，目前不在代理阶段再次扫描。vNext 接受这一边界，并应在 consent 中披露。

### 4.5 代理阶段不做第二次扫描

所有用户数据的扫描、归一化、人工 review 和盖章都发生在 ReplayBundle 生成之前。

代理不负责：

- 再次扫描 prompt；
- 清理 skill description；
- 改写 System Prompt；
- 删除工具 schema；
- 做第二次 normalization；
- 临时读取原始 session 补充字段；
- 向 CLI 请求中再次注入一份 metadata。

代理只负责：

- 一次性 route token；
- 上游真实凭据隔离；
- provider / model 路由；
- 必要的协议转换；
- 请求次数和生命周期控制；
- usage、状态和请求哈希回执。

哈希请求字节属于审计，不属于内容扫描。

### 4.6 terminal meta 是唯一新增的会话消息

脱敏后的历史内容应保持原顺序。MOSGA 只在末尾增加一条明确标注的 user message，用于说明：

- 这是一次 MOSGA 数据贡献投递；
- 此消息不属于原始会话；
- 来源 CLI / CLI version；
- 来源模型时间线；
- 轨迹统计与已知省略项；
- 脱敏、人工 review 和 consent 信息；
- 目标 provider / model；
- 只需回复 `ACK`。

不要再增加第二条 provenance message，也不要把这些信息塞进 system role。

### 4.7 不允许静默降级

若 CLI 无法恢复 session、目标模型不兼容、协议转换失败或运行环境不完整：

- 本次 CLI-authentic submission 失败；
- receipt 记录明确失败原因；
- 不自动切换到 MOSGA 自行拼装 messages 的 direct API 请求。

用户可以另行显式选择 `reconstructed-api` 兼容模式，但两种模式必须在 UI、consent 和 receipt 中区分。

## 5. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                    MOSGA preparation                         │
│                                                              │
│  原始 native session                                         │
│       +                                                      │
│  有效 CLAUDE.md / AGENTS.md 指令快照                          │
│       │                                                      │
│       ▼                                                      │
│  结构保持型脱敏 → 人工 review → consent → ReplayBundle 盖章   │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                 isolated replay runtime                      │
│                                                              │
│  临时 CLI home / 临时 project root / 脱敏 native session      │
│  脱敏 instruction files / 只读 skill roots / 无原工作区挂载    │
│                                │                             │
│                                ▼                             │
│                  Claude Code / Codex CLI                     │
│          resume session + terminal meta message              │
│                                │                             │
│          CLI 运行时组装 System Prompt、tools、skills           │
└───────────────────────────────┬──────────────────────────────┘
                                │ route token
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                    local one-shot proxy                      │
│                                                              │
│  凭据隔离 → 路由 → 必要协议转换 → 单请求控制 → receipt          │
│                    不扫描、不改写 prompt                       │
└───────────────────────────────┬──────────────────────────────┘
                                │ real upstream credential
                                ▼
                       target provider / model
```

## 6. ReplayBundle

ReplayBundle 是“用户已经检查并同意用于 CLI 续跑的固定输入”，不是简单的导出聊天记录。

建议的逻辑结构：

```text
replay-bundle/
├─ bundle.json
├─ native-session/
│  └─ <source-cli-native-layout>
├─ project-context/
│  ├─ <sanitized CLAUDE.md chain>
│  └─ <sanitized AGENTS.md chain>
├─ review/
│  ├─ findings.json
│  └─ decision.json
└─ integrity/
   └─ manifest.json
```

这是逻辑结构，不要求最终一定是一个普通目录；也可以是临时目录、压缩包或 content-addressed workspace。

### 6.1 `bundle.json`

至少记录：

```json
{
  "schemaVersion": "1.0.0",
  "source": {
    "cli": "codex",
    "recordedCliVersion": "0.x",
    "sessionFormat": "codex-rollout-jsonl",
    "sessionId": "sanitized-or-derived-id"
  },
  "runtime": {
    "mode": "cli-resume",
    "projectAlias": "project-1",
    "workingDirectoryAlias": "/workspace/project-1",
    "instructionPolicy": "sanitized-snapshot",
    "skillPolicy": "cli-discovery-read-only",
    "maxInferenceRequests": 1
  },
  "delivery": {
    "targetProviderId": "deepseek",
    "targetModel": "deepseek-chat"
  },
  "integrity": {
    "contentHash": "sha256:..."
  }
}
```

### 6.2 哈希边界

`contentHash` 应覆盖：

- 脱敏后的原生 session；
- 脱敏后的项目指令文件；
- terminal meta 的确定性输入字段；
- bundle manifest；
- 目标 provider；
- 目标 model；
- replay mode；
- runtime policy；
- skill policy；
- 已知 omission policy。

它不可能覆盖 CLI 尚未动态生成的 System Prompt 和 tool schema。因此 consent 需要同时绑定：

1. 用户已 review 的固定 bundle 字节；
2. 允许来源 CLI 在运行时加入其自身上下文的明确策略。

## 7. 项目指令上下文

### 7.1 为什么必须单独处理

缺少 `CLAUDE.md` / `AGENTS.md` 时，CLI 虽然仍能恢复消息，但其行为上下文已经变化，请求真实性会明显下降。

这些文件应在准备阶段形成“effective instruction closure”：

- 来源 CLI 在原 session 工作目录下本来会发现的项目级指令；
- 父目录或嵌套目录中按 CLI 规则生效的指令；
- 必要时包括用户明确选择保留的用户级指令；
- 不包括与当前 session 无关的整个文件树。

### 7.2 处理规则

- 在代理启动前完成发现；
- 复制到隔离工作区；
- 经过与 session 内容相同的 secret / PII / custom rule 处理；
- 进入人工 review；
- 被 ReplayBundle `contentHash` 覆盖；
- 按原相对作用域摆放，使 CLI 自己加载；
- 不把文件正文手工拼进 terminal meta。

若某个有效指令文件未被纳入，必须在 manifest 的 `omissions` 中明确记录，而不能假装上下文完整。

## 8. skills 的运行边界

skills 与项目指令不同：

- 项目指令通常会直接进入首次请求；
- skill body 通常只在 skill 被调用后才加载；
- 首次请求主要携带 CLI 发现到的 skill description。

因此当前方案不复制 skill 内容进 ReplayBundle，也不由 MOSGA 重建 skill 列表。

隔离运行环境可以只读暴露用户原有 skill roots，让 CLI 自己决定：

- 哪些 skill 可见；
- description 如何进入 System Prompt；
- 何时需要加载完整正文。

为避免 terminal meta 引发额外 agent 行为：

- terminal meta 不提出需要工具或 skill 的任务；
- 明确要求只回复 `ACK`；
- proxy route 只允许首个推理请求；
- 首次响应完成后立即关闭 route；
- 后续模型请求一律拒绝。

此处的一次性 route 是流量控制和副作用控制，不是安全扫描。

## 9. 隔离运行环境

CLI 不应直接在原项目和原 session 文件上续跑。

每次投递创建一个短生命周期隔离环境：

```text
temporary replay root
├─ cli-home/
│  ├─ staged native session
│  └─ minimum required CLI config
├─ workspace/
│  └─ sanitized instruction context
└─ runtime/
   └─ route information
```

要求：

- 原 session 只读；
- 原项目不挂载；
- staged session 可由 CLI 写入，但写入不会回流原 session；
- instruction snapshot 只读；
- skills root 只读；
- 上游 provider key 不进入子进程；
- 子进程只得到短期 route token；
- 尽可能禁止非必要 telemetry、更新检查和额外网络访问；
- CLI 退出后销毁临时环境；
- 仅保留用户允许的 receipt 和审计摘要。

隔离环境同时解决两个问题：

1. CLI 可以按正常目录结构恢复 session；
2. 即使模型返回意外工具调用，也不能直接操作用户真实项目。

## 10. CLI adapter

为 Claude Code 和 Codex 分别实现来源 adapter。adapter 负责 CLI 差异，不负责重建 prompt。

逻辑接口应覆盖：

- 检测 CLI 是否安装；
- 读取 CLI version；
- 判断 session 格式兼容性；
- 创建 CLI 所需的 session storage layout；
- 创建隔离 home 和工作目录；
- 生成 headless resume 命令；
- 注入代理路由配置；
- 将 terminal meta 作为唯一新增用户输入；
- 捕获退出码和可诊断错误；
- 清理临时环境。

概念命令形态：

```text
Claude Code:
  claude -p --resume <staged-session-id> "<terminal-meta>"

Codex:
  codex exec resume <staged-session-id> "<terminal-meta>"
```

这些只是已验证可行的命令方向，不是最终稳定接口。具体参数必须按受支持 CLI version 做 adapter 级测试，不能在多个版本间硬编码一条永远有效的命令。

### 10.1 CLI version 策略

优先级：

1. 使用与 session 记录一致的 CLI version；
2. 若本机只有兼容版本，允许继续，但在 review 和 receipt 中显示差异；
3. 若 session 格式不兼容或 CLI 拒绝恢复，失败关闭；
4. 不因恢复失败而切换到 reconstructed API。

由不同 CLI version 重新组装出的请求是“当前 CLI 有效续跑”，不是“历史请求精确复刻”。这一点必须进入产品文案。

## 11. 本地代理

本地代理复用 omnicross 已验证的总体模式：

- Claude Code 通过 Anthropic 兼容环境变量指向本地代理；
- Codex 通过 provider config override 指向本地代理，而不是假定 `OPENAI_BASE_URL` 足够；
- 子进程只拿 route token；
- 真实目标 provider key 保留在代理进程；
- 代理按 route 决定目标 provider 和 model。

### 11.1 代理允许做的事

- 校验一次性 route token；
- 确认 route 未过期且未使用；
- 记录 source CLI / target provider / target model；
- 接收 CLI 发出的首个推理请求；
- 计算 CLI 原始请求哈希；
- 做目标厂商所需的协议转换；
- 计算实际 outbound body 哈希；
- 转发请求；
- 向 CLI 返回兼容响应；
- 记录 usage、HTTP 状态和错误类别；
- 首次请求结束后关闭 route。

### 11.2 代理禁止做的事

- 修改历史消息内容；
- 注入或删除 System Prompt；
- 修改 terminal meta；
- 扫描、替换或屏蔽文本；
- 解析并重写 skill descriptions；
- 追加第二份 MOSGA manifest；
- 为提高成功率偷偷截断或总结会话；
- 在失败时使用另一条发送路径重试；
- 接受同一路由的第二次推理请求。

协议转换本身不可避免地改变 JSON 结构，因此 adapter / converter 必须通过语义等价性测试，并在 receipt 中记录 converter 名称和版本。

## 12. terminal meta message

建议保持一条短说明加结构化 manifest：

```text
This is the terminal contribution message for a sanitized AI-coding session
shared through Make Open Source Great Again (MOSGA).

This message was not part of the original session. No substantive work is
requested. Reply with exactly: ACK

<mosga-session-context>
{
  "kind": "mosga-session-context",
  "schemaVersion": "1.0.0",
  "purpose": "open-model-training-contribution",
  "source": {
    "cli": "codex",
    "recordedCliVersion": "...",
    "replayCliVersion": "...",
    "modelProvider": "...",
    "models": ["..."],
    "modelTimeline": [
      {
        "fromAssistantTurn": 0,
        "toAssistantTurn": 18,
        "model": "...",
        "reasoningEffort": "..."
      }
    ]
  },
  "trajectory": {
    "messageCount": 73,
    "assistantTurnCount": 19,
    "toolCallCount": 41,
    "hasThinking": true,
    "omissions": [
      "non-text-media",
      "raw-project-files"
    ]
  },
  "sanitization": {
    "toolVersion": "...",
    "rulesetVersion": "...",
    "humanReviewPassed": true,
    "bundleContentHash": "sha256:..."
  },
  "runtime": {
    "replayMode": "cli-resume",
    "instructionPolicy": "sanitized-snapshot",
    "skillPolicy": "cli-discovery-read-only",
    "proxyRescan": false
  },
  "delivery": {
    "targetProvider": "deepseek",
    "targetModel": "deepseek-chat"
  },
  "consent": {
    "version": "...",
    "tosRiskAcknowledged": true,
    "runtimeContextAcknowledged": true,
    "fullRetentionAcknowledged": true,
    "confirmedAt": "..."
  }
}
</mosga-session-context>
```

注意：

- 来源模型可能按 turn 变化，不能只用单一 `source.model`；
- `recordedCliVersion` 与 `replayCliVersion` 必须分开；
- `targetModel` 不能与来源模型混淆；
- omission 必须如实记录；
- manifest 从已盖章的 ReplayBundle 确定性生成；
- 代理不能在发送时临时补充未经 review 的 session metadata。

## 13. consent 与审计

### 13.1 consent 必须绑定

- ReplayBundle `contentHash`；
- target provider；
- target model；
- replay mode；
- instruction policy；
- skill policy；
- “CLI 会动态加入运行时上下文”的 acknowledgment；
- 完整保留与 ToS 风险 acknowledgment。

当前只验证 acknowledgment 和 `contentHash` 的做法不够。实际提交参数与 consent 中的 provider、model、mode 不一致时必须拒绝。

### 13.2 三种哈希

建议区分：

1. `bundleContentHash`
   - 用户 review 后固定；
   - 覆盖脱敏 session、指令快照、manifest 输入和投递策略。

2. `cliRequestHash`
   - 代理对 CLI 实际发出的请求体计算；
   - 不做内容扫描；
   - 用于证明请求确实经过 CLI 运行时组装。

3. `outboundRequestHash`
   - 对协议转换后实际发送给目标厂商的 body 计算；
   - 用于审计最终传输字节。

三者职责不同，不能互相替代。

### 13.3 receipt

成功或失败都应生成本地 receipt，至少包括：

- submission id；
- source CLI；
- recorded / replay CLI version；
- source session id 的脱敏标识；
- bundle content hash；
- CLI request hash；
- outbound request hash；
- target provider / model；
- converter / converter version；
- request count；
- started / completed time；
- HTTP status；
- usage；
- route 是否正常关闭；
- 失败阶段与稳定错误码；
- consent version。

receipt 不应保存完整 prompt 或 provider key。

## 14. 单次请求与响应处理

这次投递的价值在输入，不在模型响应。

执行规则：

- terminal meta 要求准确回复 `ACK`；
- 将最大输出 token 限制到兼容目标的较小值；
- 接受简短文本响应作为成功；
- 不把响应追加回原 session；
- 不因非 `ACK` 响应自动发起纠正请求；
- 不执行第二轮模型推理；
- 不把 throwaway completion 当成贡献数据；
- route 在首个响应完成或失败后立即失效。

如果目标响应包含 tool call：

- 不允许因此触发第二次模型调用；
- 隔离工作区避免它影响真实项目；
- receipt 标记 `unexpected_tool_request`；
- 是否把首次投递视为成功由提交策略决定，但不能继续 agent loop。

## 15. 端到端时序

```text
用户          MOSGA          隔离环境        来源 CLI        本地代理       目标厂商
 │              │                │               │               │              │
 │ 选择 session │                │               │               │              │
 ├─────────────►│                │               │               │              │
 │              │ 原生格式脱敏   │               │               │              │
 │              │ 指令快照脱敏   │               │               │              │
 │              │ 人工 review    │               │               │              │
 │ consent      │                │               │               │              │
 ├─────────────►│                │               │               │              │
 │              │ 创建/盖章 bundle               │               │              │
 │              ├───────────────►│               │               │              │
 │              │ 注册一次性 route                               │              │
 │              ├───────────────────────────────────────────────►│              │
 │              │                │ 启动 resume   │               │              │
 │              ├───────────────►├──────────────►│               │              │
 │              │                │ terminal meta │               │              │
 │              │                ├──────────────►│               │              │
 │              │                │               │ CLI 组装请求   │              │
 │              │                │               ├──────────────►│              │
 │              │                │               │               │ 协议转换/转发 │
 │              │                │               │               ├─────────────►│
 │              │                │               │               │◄─────────────┤
 │              │                │               │◄──────────────┤              │
 │              │                │               │ 结束           │              │
 │              │                │◄──────────────┤               │              │
 │              │ receipt        │               │               │              │
 │◄─────────────┤                │               │               │              │
```

## 16. 失败策略

下列情况一律 fail closed：

- ReplayBundle hash 与 review 记录不一致；
- consent 的 provider / model / mode 与 route 不一致；
- 原生 session 无法被对应 CLI 识别；
- CLI version 不兼容；
- 指令快照 staging 失败；
- route token 无效、过期或已使用；
- CLI 尝试第二次模型请求；
- converter 不支持当前 request shape；
- 目标厂商拒绝 system / tools / message 结构；
- 请求超过目标 context window 且 CLI 无法自行处理；
- 代理发现 target 与已同意配置不一致；
- receipt 关键字段无法生成。

允许重试的情况也必须创建新 route；不能复用旧 token，也不能在用户不知情时改变 provider、model 或 replay mode。

## 17. context window 与轨迹完整性

当前产品优先级是“请求真实性”，不是“保证完整轨迹逐 token 到达”。

使用 CLI 续跑后，context window 仍可能导致：

- CLI 截断旧消息；
- CLI 自动压缩或摘要历史；
- 目标模型 context window 小于来源模型；
- provider converter 丢弃不支持的结构。

处理原则：

- 不由 MOSGA 私自总结历史；
- 优先让 CLI 使用其原生 context 管理逻辑；
- receipt 记录目标 context window、CLI 是否报告 compaction / truncation；
- terminal manifest 记录原轨迹总量与已知 omission；
- 若目标协议明确无法容纳请求，失败关闭，不静默缩短。

这意味着投递的是“CLI 对该脱敏 session 的真实当前续跑请求”，而不是无条件完整复制所有历史字节。

## 18. 与现有 direct-submit 的关系

当前实现已经具备：

- 多厂商 request builder；
- converter；
- transport；
- terminal `ContributionMeta`；
- usage / receipt；
- consent gate。

vNext 不需要丢弃这些能力，但需要重新划分职责：

| 现有职责 | vNext 去向 |
|---|---|
| 从 `SanitizedSession.messages` 重建完整请求 | 降级为兼容模式，不用于 CLI-authentic 模式 |
| 生成 terminal meta | 保留，改为从 ReplayBundle 确定性生成 |
| provider preset / converter | 下沉到本地代理 |
| 直接持有并使用用户 provider key | 改为代理持有，CLI 只见 route token |
| transport fetch | 由本地代理执行 |
| usage / receipt | 保留并扩充三种哈希、CLI version、converter |
| consent gate | 扩充 target / mode / runtime policy 绑定 |

建议模式命名：

- `cli-resume`：默认的请求真实性模式；
- `reconstructed-api`：明确降级的兼容模式；
- 不使用含糊的 `direct` 同时指代两者。

## 19. 安全边界

### 19.1 已审查数据

- 脱敏 native session；
- 脱敏项目指令快照；
- terminal manifest 的固定字段；
- 用户选择的目标和策略。

### 19.2 CLI 运行时可信上下文

- CLI 自带 System Prompt；
- CLI 自带工具定义；
- CLI 动态环境说明；
- CLI 发现的 skill descriptions；
- CLI 对 context window 的原生处理。

这些内容不由代理二次扫描。用户通过 runtime-context consent 接受这一点。

### 19.3 不可信或隔离内容

- 原项目完整文件树；
- 原始未脱敏 session；
- 用户真实 provider key；
- 模型返回的潜在工具操作。

这些内容不得直接暴露给 CLI replay 子进程或目标厂商。

## 20. 验收标准

Claude Code 和 Codex 两条 adapter 都应通过以下验证：

1. CLI 能从 staged native session 成功 resume；
2. 目标请求确实由 CLI 发往本地代理；
3. terminal meta 是唯一新增 user message；
4. 请求包含来源 CLI 当前生成的 System Prompt / tool schema；
5. staged `CLAUDE.md` / `AGENTS.md` 的脱敏 canary 出现在预期运行上下文；
6. 原始敏感 canary 不出现在 CLI request 和 outbound request；
7. CLI 初始请求只出现 skill description canary，不出现未调用 skill body canary；
8. proxy 代码路径未调用 sanitizer；
9. proxy 不改变 message 文本和 terminal meta；
10. converter 前后语义等价；
11. 每个 route 最多接受一次推理请求；
12. CLI 子进程环境中不存在真实上游 key；
13. consent 的 provider / model / mode 任一不匹配都会拒绝；
14. receipt 同时记录 bundle、CLI request、outbound 三种 hash；
15. CLI 恢复失败时不会触发 reconstructed API fallback；
16. 临时 workspace 销毁后，原 session 和原项目无修改。

## 21. 实施顺序建议

这不是当前的实施任务清单，只是后续 change 的自然切分：

1. 定义 ReplayBundle、runtime policy、三种 hash 和 receipt contract；
2. 将 session 脱敏从“规范化消息导出”扩展为“来源原生格式保持型副本”；
3. 增加有效 `CLAUDE.md` / `AGENTS.md` 发现、脱敏和 staging；
4. 建立隔离 replay runtime；
5. 实现 Claude Code adapter；
6. 实现 Codex adapter；
7. 将 provider routing / converter / credential handling 移入本地 one-shot proxy；
8. 更新 terminal manifest；
9. 修正 consent target / mode / runtime policy binding；
10. 加入 CLI request capture-hash、outbound hash 和扩展 receipt；
11. 对 CLI version、provider 和 protocol converter 建立兼容性测试矩阵；
12. 将现有直接重建请求路径重命名为显式兼容模式。

## 22. 仍需通过实现前 spike 验证的事项

### 22.1 Claude Code

- staging 后 session id 与 project path 的映射规则；
- `--resume` 在隔离 home 下的最小必需文件；
- headless 模式下 terminal prompt 的精确参数组合；
- 如何在不暴露真实 key 的前提下注入本地 route；
- 如何稳定关闭非必要网络和更新检查；
- 当前版本对 tools / skills / instruction files 的具体装配行为。

### 22.2 Codex

- `codex exec resume` 对 staged rollout 的目录和索引要求；
- provider config override 的最小配置；
- `responses` wire API 与目标 provider 的转换边界；
- `AGENTS.md` 作用域在隔离目录中的复现方式；
- global skills / project skills 在隔离 home 下的发现路径。

### 22.3 跨 provider

- 哪些目标原生接受 Anthropic Messages；
- 哪些目标需要转为 Chat Completions；
- 哪些目标需要 Responses；
- tool schema、reasoning 字段、system/developer role 的降级规则；
- 目标模型不支持工具或特殊 content block 时是转换还是失败。

这些 spike 的目标是验证 adapter 边界，不是重新讨论“由 MOSGA 拼 System Prompt”这条已被否决的路线。

## 23. 非目标

本方案暂不解决：

- 验证厂商是否把数据用于训练；
- 绕过厂商 ToS 或数据政策；
- 完整复刻历史 CLI build；
- 为任意未知 code CLI 自动恢复 session；
- 在 proxy 阶段增加 DLP / 第二次 sanitizer；
- 把完整 skills 内容打包进贡献；
- 复制完整原项目；
- 将模型的 ACK 或其他回复加入公开数据集；
- 保证所有历史消息在 context window 内完整出现。

## 24. 最终方案摘要

```text
              用户确认的固定内容
       native session + project instructions
                         │
               脱敏 / review / hash
                         │
                         ▼
                   ReplayBundle
                         │
              staged isolated runtime
                         │
                         ▼
               原 Claude/Codex CLI
      运行时装配 system + tools + skill descriptions
                         │
               terminal meta user turn
                         │
                         ▼
              no-rescan one-shot proxy
      route token / key isolation / conversion / receipt
                         │
                         ▼
                  target provider
```

最终责任分界：

- **MOSGA preparation**：保证用户选择的数据已经脱敏、review、盖章并获得 consent；
- **source CLI**：保证请求按 CLI 当前真实运行逻辑组装；
- **proxy**：保证请求被正确路由、凭据隔离、必要转换且只发送一次；
- **receipt**：证明哪一个 bundle 通过哪一个 CLI 和 converter，被投递到了哪一个目标。

这条链路保住了当前最重要的产品目标：投递给目标厂商的不是 MOSGA 猜出来的“Claude/Codex 风格请求”，而是 Claude Code / Codex 自己基于脱敏 session 生成的真实续跑请求。

## 25. 调查依据

本方案基于以下已核对事实：

- 当前 MOSGA direct-submit 最终直接调用 `fetch`，不会启动 Claude Code / Codex；
- 当前已经存在 terminal `ContributionMeta`，问题是其字段和运行上下文不足；
- Codex reader 当前跳过 `session_meta` 和 `turn_context`；
- 原始 session 文件不应被假定包含完整运行时 System Prompt；
- 本机 Claude Code 支持 headless print / resume 方向；
- 本机 Codex 支持 `exec resume` 方向；
- omnicross 已验证 Claude 环境变量代理注入模式；
- omnicross 已验证 Codex 需要 provider config override，而不能只依赖 `OPENAI_BASE_URL`；
- omnicross 已验证“CLI 只持 route token、真实 provider key 留在代理侧”的凭据隔离模式。

前置分析见：

- `rasen/office-hours/api-direct-submit-session-context.md`
- `rasen/office-hours/agent-session-data-contribution.md`

参考实现：

- `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`
