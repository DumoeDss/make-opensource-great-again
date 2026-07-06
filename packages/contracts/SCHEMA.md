> ⚠️ **待发起人腹稿校准** — This schema is the initiator's **un-finalized draft**
> (design doc Open Question 1). The field list below is a working shape, not a
> frozen contract. When the initiator's dataset schema is provided, a
> coordinated `schemaVersion` bump absorbs it. Sibling slices MUST treat these
> names as fixed **until** that calibration; do not drift silently.

# mosga sanitized-session intermediate format

The `SanitizedSession` envelope is the shared intermediate format every v0.1
slice aligns to: 采集 (readers, this slice) → 脱敏 (sanitizer) → 人工确认 (review-ui)
→ 导出/PR (publisher). Its body is kept **structurally isomorphic to the original
Claude Code JSONL** so 出口② (API replay) remains possible. Dataset slicing —
shaping the export into a training-dataset layout — is deferred to the **export
layer (slice 4)**, not done here.

Readers emit envelopes with `meta.sanitized: false` and
`meta.sanitizationRulesetVersion: null`; the sanitizer (slice 2) stamps them.

## Envelope

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `string` | mosga intermediate schema version, e.g. `"0.1.0"`. The load-bearing version knob for coordinated future bumps. |
| `meta` | object | Provenance + sanitization metadata. See below. |
| `session` | object | Session identity + raw metadata. See below. |
| `messages` | `ParsedMessage[]` | Isomorphic to the source JSONL for replay. See below. |

## `meta`

| Field | Type | Notes |
| --- | --- | --- |
| `contributorAlias` | `string` | Deterministic per-session alias of the contributor. |
| `sourceCli` | enum (`"claude-code"`, …) | Extensible by appending; only `claude-code` in v0.1. |
| `toolVersion` | `string` | The mosga tool version that produced this envelope. |
| `sanitizationRulesetVersion` | `string \| null` | `null` out of readers; the sanitizer (slice 2) stamps it. |
| `exportedAt` | `string` | ISO-8601 timestamp. |
| `license` | `string \| null` | Dataset license (Open Question 2, 待定); nullable for now. |
| `sanitized` | `boolean` | `false` out of readers; `true` after the sanitizer gate. |

## `session`

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | `string` | The session id (transcript file stem). |
| `sourceId` | `string` | The adapter id that produced it (e.g. `"claude-code"`). |
| `projectKey` | `string` | The project grouping key (on-disk slug). |
| `cwd` | `string \| null` | Raw here; normalized/aliased in slice 2. |
| `title` | `string \| null` | Derived title (summary → first user turn → null). |
| `updatedAt` | `number` | Session file mtime (ms). |

## `ParsedMessage`

Structurally a superset of elftia's `ParsedAgentMessage`. Required core plus
optional fields; kept isomorphic to the source JSONL turn.

| Field | Type | Notes |
| --- | --- | --- |
| `sdkUuid` | `string` | Stable message uuid (from the JSONL entry). |
| `parentUuid` | `string \| null` | Parent message uuid, or null for the root turn. |
| `role` | `"user" \| "assistant" \| "system"` | Constrained role set. |
| `content` | `string` | The message's plain text content. |
| `sdkMessageType` | `string` | The entry's `type`/derived message type. |
| `timestamp` | `number` | Normalized timestamp (ms). |
| `toolCalls` | `ToolCall[]?` | Assistant tool calls, with merged results. |
| `toolResults` | array? | Raw tool results (results are normally merged into `toolCalls`). |
| `thinking` | `string?` | Assistant reasoning captured from `thinking` blocks. |
| `isSidechain` | `boolean?` | `true` for subagent (Task) turns. |
| `commandName` | `string?` | Parsed slash-command name. |
| `commandMessage` | `string?` | Parsed slash-command message. |
| `commandArgs` | `string?` | Parsed slash-command args. |
| `nonTextContent` | `{ blockTypes: string[] }?` | **Mark, not strip.** Present when the source turn carried non-text blocks (image/binary/unknown). `blockTypes` lists the detected block `type`s so the ⚠ human-review path can act on them. The reused parser drops such blocks silently; `session-readers` re-scans the raw entries and stamps this marker so nothing is truncated without a human seeing it. |

### `ToolCall`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Tool-call id. |
| `name` | `string` | Tool name. |
| `input` | `Record<string, unknown>` | Tool input arguments. |
| `status` | `"completed" \| "error"` | Result status after merge. |
| `result` | `string?` | Merged tool-result text. |
