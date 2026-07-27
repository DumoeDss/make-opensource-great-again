# API 直投的 Session Context 与 Terminal Meta

日期：2026-07-27
状态：前置分析；完整收敛方案已迁移至 `api-direct-submit-cli-replay-design.md`
范围：MOSGA 出口②（API 直投）

> 本文保留最初对 direct API、session metadata 和 terminal meta 的调查过程。当前完整方案以 `api-direct-submit-cli-replay-design.md` 为准。

## 问题

MOSGA 当前会把脱敏后的 Claude Code / Codex 会话重建为聊天请求，并投递到用户选择的模型厂商。仅重建消息会丢失原始 session 中的来源模型、CLI 版本、reasoning effort、运行模式等上下文，因此需要判断：

1. 哪些 session 元数据值得保留；
2. 元数据应在哪一层提取、脱敏和确认；
3. 应如何随直投请求发送；
4. 当前“直接调用厂商 API”的传输方式是否足以还原真实 code CLI 会话语义。

本文先记录前三项的分析。第四项因“原始 session 不包含运行时组装的完整 System Prompt”而重新打开，后续需与 CLI 续跑方案一起评估。

## 当前实现

当前直投已经会追加一条 terminal meta message，并非完全缺少元数据消息：

1. 从 `SanitizedSession.messages` 重建对话；
2. 生成 `ContributionMeta`；
3. 将其序列化为最后一条 `user` 消息；
4. 向目标厂商发起一次推理；
5. 丢弃生成内容，只记录 usage 和 receipt。

当前 `ContributionMeta` 包含：

- MOSGA tool version；
- sanitizer package version；
- sanitization ruleset version；
- contributor alias；
- license；
- source CLI；
- session id；
- consent acknowledgment；
- 非文本内容未携带的说明。

因此问题不是“缺少 terminal meta message”，而是它只能使用已经进入 `SanitizedSession` 的有限字段。

## 元数据在哪里丢失

当前数据流为：

```text
原始 Claude/Codex session
          │
          │ reader 主要只输出 ParsedMessage[]
          ▼
     SanitizedSession
     ├─ minimal meta
     ├─ minimal session info
     └─ messages
          │
          ▼
   terminal ContributionMeta
          │
          ▼
       API 直投
```

Codex parser 明确跳过 `session_meta` 和 `turn_context`。Claude reader 的规范化类型也没有保存 `message.model`、CLI version、git branch、effort、permission mode 等字段。daemon 最终只能构造一个包含 session id、project key、cwd、title、updatedAt 和少量 provenance 的 envelope。

因此丢失发生在 reader / normalization 边界，不是在最后的 submit serializer。

## 实际 session 可取得的字段

对本机最近各 5 个 Claude Code 和 Codex session 做了只读字段盘点；未输出路径、仓库名或对话内容。

Codex session 中可见：

- `cli_version`
- `model_provider`
- `context_window`
- `originator`
- `history_mode`
- 每轮 `model`
- 每轮 `effort`
- `approval_policy`
- `sandbox_policy`
- `collaboration_mode`
- git branch / commit / repository URL
- workspace roots、timezone、current date

Claude Code session 中可见：

- `message.model`
- CLI `version`
- `effort`
- `permissionMode`
- `mode`
- `entrypoint`
- `gitBranch`
- message usage、service tier、cache token 等

同一个 Claude Code session 可能出现多个 source model，例如主模型、subagent 模型和 synthetic message。因此不能把来源模型建模为单一 `model: string`。

至少应区分：

- `source.models`：原始轨迹中的回答由哪些模型产生；
- `delivery.targetModel`：本次直投请求发往哪个模型。

若需要精确归因，应在 assistant message 上保存来源生成上下文，或者在 terminal manifest 中使用按 assistant turn 编号的模型时间线。

## 推荐的数据流

不建议让 direct-submit 在发送前重新读取原始 JSONL 并临时拼装元数据。推荐流程为：

```text
原始 session
    │
    ├─ messages
    └─ sourceContext
          │
          ▼
  SanitizedSession vNext
          │
          ├─ 元数据参与 secret / PII 扫描
          ├─ 元数据进入人工 review
          ├─ 元数据被 contentHash 覆盖
          └─ gate unlock
                │
                ▼
   从 stamped session 确定性生成
   terminal session-context manifest
                │
                ▼
     exact outbound bytes backstop
                │
                ▼
              发送
```

原因：

- submit 阶段重新读取的数据没有经过人工 review；
- 新读取的数据不在用户确认过的 `contentHash` 中；
- 原文件可能已变化，与 review 时的内容不一致；
- pre-send raw-bytes backstop 主要硬阻挡 secrets/custom findings，普通路径、用户名等 normalization 信息仍可能通过。

因此 source metadata 应先进入统一 session contract，再被脱敏、review、盖章和 consent 绑定。

## 建议的 source context

默认保留的低风险、高价值字段：

- source CLI 与 CLI version；
- source model provider；
- assistant turn 的 source model；
- reasoning effort；
- context window；
- main agent / subagent 类型；
- session mode / entrypoint 的稳定枚举；
- message、assistant turn、thinking、tool-call 数量；
- 非文本内容存在与缺失策略；
- MOSGA schema、sanitizer、ruleset 和人工 review provenance。

默认排除的高风险或低价值字段：

- 原始 cwd、workspace roots；
- repository URL、branch、commit；
- session title；
- Codex `base_instructions`；
- 完整 sandbox / permission 对象；
- 用户自定义 instructions 原文；
- provider 内部 usage/cache 细节。

`base_instructions`、用户 instructions 和 environment context 不是普通 provenance metadata，而是模型生成回答时的 conditioning context。它们对轨迹解释可能很重要，但隐私、版权和 token 成本也更高，应作为独立、明确可选且经过 review 的能力讨论。

## Terminal manifest 草案

现有 `ContributionMeta` 应升级，而不是再增加第二条消息：

```text
This message carries provenance and source context for a sanitized AI-coding
session contributed through Make Open Source Great Again (MOSGA).

It is not part of the original conversation. No substantive response is needed.
Reply with "ACK" only.

<mosga-session-context>
{
  "kind": "mosga-session-context",
  "schemaVersion": "1.0.0",
  "purpose": "open-model-training-contribution",
  "source": {
    "cli": "codex",
    "cliVersion": "...",
    "modelProvider": "openai",
    "models": ["gpt-..."],
    "modelTimeline": [
      {
        "fromAssistantTurn": 0,
        "toAssistantTurn": 18,
        "model": "gpt-...",
        "reasoningEffort": "xhigh"
      }
    ],
    "contextWindow": 200000
  },
  "trajectory": {
    "messageCount": 73,
    "assistantTurnCount": 19,
    "toolCallCount": 41,
    "hasThinking": true,
    "nonTextPolicy": "marked-not-stored",
    "omissions": [
      "non-text-media",
      "raw-filesystem-paths",
      "repository-identity",
      "provider-base-instructions"
    ]
  },
  "sanitization": {
    "toolVersion": "...",
    "rulesetVersion": "...",
    "sanitizerVersion": "...",
    "humanReviewPassed": true
  },
  "delivery": {
    "targetProvider": "deepseek",
    "targetModel": "deepseek-chat",
    "replayMode": "single-shot"
  },
  "consent": {
    "version": "0.3.0",
    "tosRiskAcknowledged": true,
    "fullRetentionAcknowledged": true,
    "confirmedAt": "..."
  }
}
</mosga-session-context>
```

采用 terminal `user` message 的理由：

- 当前跨 Anthropic、OpenAI、OpenAI Responses、Gemini 的转换链已经能携带普通消息内容；
- 不依赖各家是否保留自定义顶层 metadata；
- 不把 donation manifest 冒充成原始 System Prompt；
- 请求以 user turn 结束，可产生一次协议上正常的 completion。

## 需要同时修正的相邻问题

### Consent target binding

当前 consent 校验只验证：

- 两个 acknowledgment 为真；
- `contentHash` 与 stamped session 一致。

它没有验证 consent 中的：

- `targetProviderId`
- `targetModel`
- `replayMode`

是否与实际请求参数一致。升级 metadata / manifest 时，应让 consent 同时绑定实际 delivery target 和 replay mode。

### Throwaway completion 成本

当前 terminal meta request 的生成结果会被丢弃，但请求允许较大的最大输出，并按较大的输出 token 数估算。terminal message 应明确要求只回复 `ACK`，并将最大输出限制在兼容各目标厂商的较小值。

### Hash 边界

新增 source metadata 必须在 consent 计算 `contentHash` 之前进入 `SanitizedSession`。若只在 submit 阶段生成，它就不属于用户确认过的内容。

可以额外在 receipt 中保存 exact outbound body hash，用于审计“最终实际发送的字节”，但该 hash 与 session content hash 的职责不同。

## 暂定结论

如果继续采用直接厂商 API 请求：

> 保留“一次完整对话 + 一条 terminal meta message”的传输形态；把缺失的来源元数据提前提升为 `SanitizedSession.sourceContext`，经过同一套扫描、review、hash 和 consent 后，再由它生成结构化 terminal manifest。不要在 submit 阶段重新读取和转发原始 metadata。

但这个结论依赖一个前提：重建出的 API messages 足以表达原 code CLI 的有效输入上下文。

新发现表明这个前提可能不成立：Claude Code / Codex 的完整 System Prompt、工具定义、运行策略和环境说明可能是运行时组装的，并不完整存在于 session JSONL 中。若缺失这些 conditioning context，直接 API 请求只是在发送“表面消息记录”，而不是一次忠实的 CLI session continuation。

下一阶段需要比较：

1. 继续直接调用模型 API；
2. 生成脱敏 session 后，拉起原 Claude Code / Codex CLI，通过环境变量把 endpoint/key 指向目标厂商，并让 CLI 在恢复后的 session 上发送 terminal meta message；
3. 混合方案：CLI 负责重建运行上下文，MOSGA 仍负责脱敏、审计和最终发送证明。

参考实现候选：`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross`。
