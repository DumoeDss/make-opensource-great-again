## MODIFIED Requirements

### Requirement: Claude Code adapter enumeration

The package SHALL ship a Claude Code adapter that enumerates `~/.claude/projects/<slug>/` project directories and each project's top-level `<id>.jsonl` sessions, producing `CliProjectRef`/`CliSessionRef` values. It SHALL skip project directories with no `.jsonl` sessions, derive each project's `cwd`/`label` by probing a session's `cwd` field (falling back to the slug when undecodable), and populate session `title`, `updatedAt` (mtime), and `sizeBytes` from disk. The Claude Code adapter is one of the registered adapters; the package also ships a Codex adapter (see "Codex adapter enumeration"), and both are registered against the same `CliSourceAdapter` interface with no consumer change.

#### Scenario: Projects and sessions enumerate from a fixture tree

- **WHEN** the adapter runs against a hand-crafted temp `projects/` tree with two project dirs (one with sessions, one empty-but-for-index)
- **THEN** it returns the populated project with its sessions and omits the session-less project

#### Scenario: Title falls back through summary then first user turn

- **WHEN** a session has a `summary` line
- **THEN** the session `title` is that summary (truncated); **WHEN** it has none, the title is the first real user text turn; **WHEN** neither exists, `title` is null

## ADDED Requirements

### Requirement: Codex adapter enumeration

The package SHALL ship a Codex adapter (source id `"codex"`) that discovers codex rollouts under `~/.codex/sessions/` — organized as a `<YYYY>/<MM>/<DD>` date tree of `rollout-<ISO-ts>-<uuid>.jsonl[.zst]` files, NOT one directory per project. It SHALL walk that tree with a bounded depth, pure filesystem read only, never throwing on a missing or unreadable directory/file (returning what it can). A single scan SHALL feed both `listProjects` and `listSessions`. For each `.jsonl` rollout it SHALL read a bounded prefix (at most 128 KB / 60 lines) to extract the `session_meta` line's `id` and `cwd` plus the first real user `input_text` turn as the title, skipping codex-injected `<environment_context>` / `<user_instructions>` scaffolding turns; the trailing UUID in the filename SHALL be the id fallback. Rollouts SHALL be grouped into projects by distinct `session_meta.cwd`; a rollout with no decodable cwd SHALL group under a synthetic `(unknown)` project whose `cwd` is `null`. Session `updatedAt` (mtime) and `sizeBytes` SHALL come from disk. The Codex adapter SHALL be registered in the adapter registry and exported from the package index, so consumers (`getAdapter`/`listAdapters`, the daemon `/api/sources*` routes, the UI picker) pick it up with no change.

#### Scenario: Rollouts enumerate from a date-tree fixture and group by cwd

- **WHEN** the adapter runs against a hand-crafted temp `~/.codex/sessions/<Y>/<M>/<D>/` tree holding a `rollout-*-<uuid>.jsonl` whose `session_meta` carries a `cwd`
- **THEN** `listProjects` returns one project keyed on that `cwd` (label = its basename) and `listSessions` returns the rollout ref with `id` (the thread uuid), absolute `path`, the first non-scaffolding user turn as `title`, and disk `updatedAt`/`sizeBytes`

#### Scenario: A rollout with no cwd groups under a synthetic (unknown) project

- **WHEN** a rollout's `session_meta` has no usable `cwd`
- **THEN** it is grouped under a project whose `key` is `(unknown)` and whose `cwd` is `null`, so downstream annotation marks it not-recommended rather than throwing

#### Scenario: Missing codex tree degrades cleanly

- **WHEN** the `~/.codex/sessions/` root does not exist or is unreadable
- **THEN** `listProjects` and `listSessions` return empty arrays without throwing

#### Scenario: Compressed rollouts are skipped this slice

- **WHEN** a rollout file has a `.jsonl.zst` extension
- **THEN** the adapter recognizes it but does not decompress or enumerate it (no zstd dependency is introduced), and enumeration of sibling `.jsonl` rollouts is unaffected

### Requirement: Codex transcript parsing to the shared message form

The package SHALL parse a codex rollout to `ParsedMessage[]` via a codex-specific parser (adapted from elftia's `codexRolloutParser`, MIT reuse), returning `[]` on a missing/unreadable/zero-message file and never throwing (unparseable lines are skipped). It SHALL treat `response_item` lines as the single source of truth and IGNORE the mirror `event_msg` stream so messages are not doubled. It SHALL map: `message` role=user `input_text` → a user message (skipping `<environment_context>`/`<user_instructions>` scaffolding turns), `message` role=assistant `output_text` → an assistant message, `reasoning.summary[].summary_text` → an assistant message carrying `thinking` with empty content, `function_call` / `custom_tool_call` → a `ToolCall` on a fresh assistant message paired by `call_id`, and `function_call_output` / `custom_tool_call_output` → merged onto the owning tool call by `call_id`. Codex tool names/args SHALL be normalized to the shared vocabulary (`shell`/`shell_command` → `Bash`, `update_plan` → `TodoWrite`; others verbatim) and the `{output, metadata}` tool-output envelope unwrapped, with a nonzero `metadata.exit_code` marking the tool call `error`. The parser SHALL be the codex adapter's `parseTranscriptToMessages` delegate. A `.jsonl.zst` rollout SHALL parse to `[]` this slice (no decompression).

#### Scenario: Response items map to user/assistant/tool messages, event_msg ignored

- **WHEN** parsing a rollout whose `response_item` lines include a real user `message`, an assistant `message`, a `function_call` and its `function_call_output`, alongside a mirror `event_msg` stream
- **THEN** the result contains the user message, the assistant message, and a single assistant message whose tool call carries the merged output — the `event_msg` lines produce no duplicate messages

#### Scenario: Shell tool is normalized and a nonzero exit marks an error

- **WHEN** a `function_call` names `shell` with a `["bash","-lc","<cmd>"]` command and its output envelope reports `metadata.exit_code` != 0
- **THEN** the tool call is emitted as `Bash` with the unwrapped command and its status is `error`

#### Scenario: A codex user turn with an image part is marked, never dropped

- **WHEN** parsing a codex `message` whose content array contains a non-`input_text` part (e.g. an `input_image`) alongside text
- **THEN** the corresponding `ParsedMessage` carries a `nonTextContent` marker listing that part's `type`, and a message with only `input_text`/`output_text` parts carries no marker

#### Scenario: Missing or compressed rollout parses to empty

- **WHEN** the rollout path is missing/unreadable, parses to zero messages, or is a `.jsonl.zst` file
- **THEN** the parser returns `[]` without throwing
