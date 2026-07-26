## MODIFIED Requirements

### Requirement: CliSourceAdapter pluggable interface

The package SHALL define a `CliSourceAdapter` interface providing enumeration, metadata, a normalized parse delegate, and strict native capture: `readonly id`, `readonly displayName`, `locateRoots(home)`, `listProjects(roots)`, `listSessions(roots, project)`, `resolveTranscriptPath(ref)`, `parseTranscriptToMessages(transcriptPath)`, and `captureNativeSession(ref)`. `captureNativeSession` SHALL return a discriminated `NativeCaptureResult` rather than a partial artifact or an untyped exception. The interface SHALL exclude elftia's display-IR `read`, memory, subagent, and continue methods (those belong to elftia's GUI, not mosga's export pipeline). A registry SHALL expose adapters by id (e.g. `getAdapter(id)` / `listAdapters()`) so adding a CLI is registering one adapter with no change to consumers.

#### Scenario: Registry returns the Claude Code adapter by id

- **WHEN** a consumer requests the adapter for `"claude-code"`
- **THEN** the registry returns the Claude Code adapter, `listAdapters()` includes it, and the adapter exposes both normalized parsing and native capture

#### Scenario: Interface accommodates a future adapter shape

- **WHEN** a hypothetical Codex/Cursor adapter is written against the interface
- **THEN** it can be registered, enumerated, normalized, and natively captured without modifying `CliSourceAdapter` or the registry (verified by a fake second adapter in tests)

## ADDED Requirements

### Requirement: Strict source-native JSONL capture

For a supported uncompressed transcript, `captureNativeSession` SHALL perform read-only strict capture into the shared native-session contract. It SHALL parse every nonblank JSONL line as an object, retain every row in source order with a stable ordinal, and preserve all known and unknown JSON values without normalized-message filtering, deduplication, tool-result merging, scaffolding removal, row-type removal, or field projection. It SHALL derive source summary fields only from this retained artifact and SHALL NOT mutate the source file.

#### Scenario: Claude meta and unknown rows are preserved

- **WHEN** a Claude fixture includes message, summary/meta, tool-result, and unknown future row shapes
- **THEN** native capture returns every row in the original order while the existing normalized parser continues to return its current projected messages

#### Scenario: Codex context rows are preserved

- **WHEN** a Codex fixture includes `session_meta`, `turn_context`, `response_item`, `event_msg`, and an unknown future row
- **THEN** native capture retains all five row categories even though normalized parsing continues to ignore the context and mirror rows

### Requirement: Native capture fails closed without partial replay

Native capture SHALL return a stable failure code for a missing/unreadable file, empty session, malformed nonblank line, non-object JSONL row, unsupported source format, or unsupported compression. The failure result SHALL identify the source and failure category without including raw transcript content, an original absolute path, or a credential. It SHALL NOT return earlier valid rows from a file after a later row fails.

#### Scenario: Malformed later row rejects the whole capture

- **WHEN** a transcript contains valid rows followed by a malformed nonblank line
- **THEN** native capture returns `malformed-jsonl` with no partial native artifact

#### Scenario: Compressed Codex rollout is explicit unsupported input

- **WHEN** native capture receives a `.jsonl.zst` Codex ref in v1
- **THEN** it returns `unsupported-compression` rather than an empty or apparently successful session

### Requirement: Native source summary is safe and deterministic

Native capture SHALL derive available recorded CLI version, model provider, distinct source models, assistant-turn model/effort timeline, context window, stable session mode/entrypoint values, and trajectory counts deterministically from retained rows. It SHALL not copy raw cwd, workspace roots, repository URL/branch/commit, title, provider cache/usage internals, or raw base instructions into the summary. Missing summary values SHALL be null/empty and reflected by callers as omissions rather than invented.

#### Scenario: Multiple source models remain a timeline

- **WHEN** retained rows show different models on different assistant turns
- **THEN** the source summary contains distinct models and a turn-indexed timeline instead of collapsing them into one `model` field

#### Scenario: Repository identity stays out of the summary

- **WHEN** native rows contain cwd, repository URL, branch, and commit metadata
- **THEN** those values remain available only at their native structural locations for sanitization and do not appear in the derived summary

### Requirement: Native capture tests use hand-crafted fixtures only

All native-capture tests SHALL use hand-crafted fake JSONL in repository fixtures or temporary directories. They SHALL assert read-only behavior, full row/unknown-field preservation, safe source-summary extraction, and fail-closed errors without reading a real home directory or real CLI transcript.

#### Scenario: Real user data is never a fixture dependency

- **WHEN** the session-reader test suite runs
- **THEN** every native capture source is fake or temporary and no `~/.claude` or `~/.codex` session is accessed
