## ADDED Requirements

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

The package SHALL ship a Claude Code adapter that enumerates `~/.claude/projects/<slug>/` project directories and each project's top-level `<id>.jsonl` sessions, producing `CliProjectRef`/`CliSessionRef` values. It SHALL skip project directories with no `.jsonl` sessions, derive each project's `cwd`/`label` by probing a session's `cwd` field (falling back to the slug when undecodable), and populate session `title`, `updatedAt` (mtime), and `sizeBytes` from disk. v0.1 ships ONLY this adapter.

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
