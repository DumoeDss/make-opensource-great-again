## ADDED Requirements

### Requirement: Reader reference schemas

The `@mosga/contracts` package SHALL export zod schemas and inferred TS types for the reader-layer references that enumeration produces. It SHALL export `CliProjectRefSchema` with fields `{ sourceId: string, key: string, cwd: string | null, label: string }` and `CliSessionRefSchema` with fields `{ sourceId: string, projectKey: string, id: string, path: string, title: string | null, cwd: string | null, updatedAt: number, sizeBytes: number }`. These mirror elftia's shapes minus the elftia-display-only `startedInElftia` field.

#### Scenario: Valid reference parses

- **WHEN** a well-formed project or session reference object is validated against its schema
- **THEN** the schema accepts it and the inferred type matches the documented fields exactly

#### Scenario: Missing required field is rejected

- **WHEN** an object missing a required field (e.g. a session ref without `path`) is validated
- **THEN** the schema rejects it with a validation error rather than silently coercing

### Requirement: Parsed-message schema

The package SHALL export a `ParsedMessageSchema` (with inferred type `ParsedMessage`) describing one parsed transcript message, structurally a superset of elftia's `ParsedAgentMessage`: `{ sdkUuid: string, parentUuid: string | null, role: 'user' | 'assistant' | 'system', content: string, sdkMessageType: string, timestamp: number }` plus optional `toolCalls`, `toolResults`, `thinking`, `isSidechain`, `commandName`, `commandMessage`, `commandArgs`. It SHALL additionally carry an optional non-text-content marker (see `session-readers`) so image/binary presence survives into the contract rather than being dropped.

#### Scenario: A message carrying tool calls and thinking round-trips

- **WHEN** a parsed message with `toolCalls`, `thinking`, and a `timestamp` is validated
- **THEN** the schema accepts it and preserves every field on the inferred type

#### Scenario: Role is constrained to the known set

- **WHEN** a message with a `role` outside `user | assistant | system` is validated
- **THEN** the schema rejects it

### Requirement: Sanitized-session intermediate envelope

The package SHALL export a `SanitizedSessionSchema` (inferred type `SanitizedSession`) — the shared intermediate format every v0.1 slice aligns to. It SHALL contain: a `schemaVersion` string; a `meta` object with at least `{ contributorAlias, sourceCli, toolVersion, sanitizationRulesetVersion (nullable), exportedAt (ISO-8601 string), license (nullable), sanitized (boolean) }`; a `session` object with `{ sessionId, sourceId, projectKey, cwd (nullable), title (nullable), updatedAt }`; and a `messages` array of `ParsedMessage`. The body SHALL be kept structurally isomorphic to the original Claude Code JSONL so 出口② replay remains possible; dataset slicing is deferred to the export layer (slice 4). Readers emit envelopes with `sanitized: false` and `sanitizationRulesetVersion: null`; the sanitizer (slice 2) stamps them.

#### Scenario: A reader-produced envelope validates

- **WHEN** an envelope with `sanitized: false`, `sanitizationRulesetVersion: null`, populated `meta`/`session`, and a `messages` array is validated
- **THEN** the schema accepts it

#### Scenario: sourceCli is an extensible enum defaulting to claude-code

- **WHEN** `meta.sourceCli` is `"claude-code"`
- **THEN** the schema accepts it, and the enum is defined so Codex/Cursor values can be added later without a breaking change to consumers

### Requirement: SCHEMA.md design record

The package SHALL ship a `SCHEMA.md` documenting the sanitized-session intermediate format (field-by-field: envelope, meta, session, message). Because the initiator's dataset schema is an un-finalized draft (Open Question 1), `SCHEMA.md` SHALL carry a banner at the very top marking it **"待发起人腹稿校准"** (pending calibration against the initiator's draft). It SHALL state the isomorphism guarantee (body mirrors source JSONL for replay) and that dataset slicing happens in the export layer.

#### Scenario: SCHEMA.md carries the calibration banner

- **WHEN** a reader opens `SCHEMA.md`
- **THEN** the first content block is the "待发起人腹稿校准" banner, before any field documentation

#### Scenario: Documented fields match the exported schema

- **WHEN** `SCHEMA.md` describes the envelope fields
- **THEN** every documented field corresponds to a field actually present in `SanitizedSessionSchema` (no drift between doc and code)
