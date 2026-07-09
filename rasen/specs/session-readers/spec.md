# session-readers

## Purpose

Defines the `@mosga/session-readers` package: read-only, cross-platform discovery and parsing of local CLI coding-agent sessions (Claude Code for v0.1) into the shared `ParsedMessage` contract, via a pluggable `CliSourceAdapter` interface.
## Requirements
### Requirement: Read-only, degrade-cleanly filesystem discovery

The `@mosga/session-readers` package SHALL discover local Claude Code sessions by pure filesystem read only. It SHALL never write to, move, or delete anything under the source roots, and SHALL never throw on a missing or unreadable directory/file — it returns what it can (empty results on failure). The home directory SHALL be resolved via `os.homedir()` with `process.env.USERPROFILE` / `process.env.HOME` fallbacks and no dependency on electron or any GUI runtime.

#### Scenario: Missing projects root yields empty results

- **WHEN** the `~/.claude/projects/` root does not exist
- **THEN** discovery returns an empty project list without throwing

#### Scenario: Unreadable or malformed file is skipped, not fatal

- **WHEN** a session file is unreadable or a JSONL line is malformed
- **THEN** the reader skips that file/line and continues, returning the entries it could parse

#### Scenario: No electron dependency

- **WHEN** the package is imported in a plain Node process (no electron)
- **THEN** it loads and runs discovery successfully, resolving home via `os.homedir()`/env fallback

### Requirement: Cross-platform Claude Code project-path encoding

The package SHALL provide `encodeProjectPath(projectPath)` that replaces every non-alphanumeric character with `-`, without collapsing consecutive `-` or trimming leading/trailing `-`, matching the on-disk `~/.claude/projects/<encoded-cwd>/` slug rule. Path handling SHALL use `node:path` so it is correct on Windows and POSIX.

#### Scenario: Windows cwd encodes to its on-disk slug

- **WHEN** `encodeProjectPath` is given a Windows path such as `C:\Users\Sayo\AppData\Roaming\@waifuoid\elftia\clawia`
- **THEN** it returns `C--Users-Sayo-AppData-Roaming--waifuoid-elftia-clawia` (no collapsing, no trimming)

### Requirement: CliSourceAdapter pluggable interface

The package SHALL define a `CliSourceAdapter` interface providing enumeration + metadata + parse-delegation only: `readonly id`, `readonly displayName`, `locateRoots(home)`, `listProjects(roots)`, `listSessions(roots, project)`, `resolveTranscriptPath(ref)`, and `parseTranscriptToMessages(transcriptPath)`. It SHALL exclude elftia's display-IR `read`, memory, subagent, and continue methods (those belong to elftia's GUI, not mosga's export pipeline). A registry SHALL expose adapters by id (e.g. `getAdapter(id)` / `listAdapters()`) so adding a CLI is registering one adapter with no change to consumers.

#### Scenario: Registry returns the Claude Code adapter by id

- **WHEN** a consumer requests the adapter for `"claude-code"`
- **THEN** the registry returns the Claude Code adapter, and `listAdapters()` includes it

#### Scenario: Interface accommodates a future adapter shape

- **WHEN** a hypothetical Codex/Cursor adapter is written against the interface
- **THEN** it can be registered and enumerated without modifying `CliSourceAdapter` or the registry (verified by a fake second adapter in tests)

### Requirement: Claude Code adapter enumeration

The package SHALL ship a Claude Code adapter that enumerates `~/.claude/projects/<slug>/` project directories and each project's top-level `<id>.jsonl` sessions, producing `CliProjectRef`/`CliSessionRef` values. It SHALL skip project directories with no `.jsonl` sessions, derive each project's `cwd`/`label` by probing a session's `cwd` field (falling back to the slug when undecodable), and populate session `title`, `updatedAt` (mtime), and `sizeBytes` from disk. The Claude Code adapter is one of the registered adapters; the package also ships a Codex adapter (see "Codex adapter enumeration"), and both are registered against the same `CliSourceAdapter` interface with no consumer change.

#### Scenario: Projects and sessions enumerate from a fixture tree

- **WHEN** the adapter runs against a hand-crafted temp `projects/` tree with two project dirs (one with sessions, one empty-but-for-index)
- **THEN** it returns the populated project with its sessions and omits the session-less project

#### Scenario: Title falls back through summary then first user turn

- **WHEN** a session has a `summary` line
- **THEN** the session `title` is that summary (truncated); **WHEN** it has none, the title is the first real user text turn; **WHEN** neither exists, `title` is null

### Requirement: Transcript parsing to the shared message form

The package SHALL parse a Claude Code transcript to `ParsedMessage[]` via the clean parse path only (`readSessionEntries` → `deduplicateEntries` → `parseJsonlEntriesToAgentMessages`), NOT elftia's display-IR `read` path. Parsing SHALL deduplicate entries by uuid (keeping the latest), preserve `thinking` and `isSidechain`, merge tool results into their tool calls, and return `[]` on a missing/unreadable/zero-message file.

#### Scenario: Duplicate uuids collapse to the latest

- **WHEN** a transcript contains two entries with the same uuid and different timestamps
- **THEN** only the later-timestamped entry survives parsing

#### Scenario: Thinking and sidechain flags are preserved

- **WHEN** a transcript contains a thinking block and a sidechain (subagent) turn
- **THEN** the parsed messages retain the `thinking` text and the `isSidechain` flag

### Requirement: Non-text content is marked, never silently dropped

The reader SHALL detect content blocks that are not text/thinking/tool_use/tool_result (e.g. `image`, base64 attachments, unknown block types) and flag their presence on the parsed message (a non-text marker on `ParsedMessage`) rather than discarding them silently. This upholds the design doc's mark-not-strip rule and its ban on silent truncation, giving the downstream ⚠ human-review path something to act on. The reused elftia parser is kept verbatim; the marker is added in a thin mosga wrapper that also scans the raw entries.

#### Scenario: A message with an image block is flagged

- **WHEN** parsing a transcript entry whose content includes an `image` (or other non-text) block
- **THEN** the corresponding `ParsedMessage` carries a non-text marker indicating non-text content is present

#### Scenario: A pure-text message is not flagged

- **WHEN** parsing a message that contains only text/thinking/tool blocks
- **THEN** the parsed message carries no non-text marker

### Requirement: Tests use hand-crafted fake fixtures only

Every test in the package SHALL run against hand-crafted fake JSONL fixtures constructed in-repo or in a temp dir. No real Claude Code session data SHALL be read from the developer's machine or committed to the repository.

#### Scenario: Tests do not read the real home directory

- **WHEN** the package test suite runs
- **THEN** it operates entirely on fake fixtures / temp directories and never depends on the presence of a real `~/.claude/projects/` tree

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

