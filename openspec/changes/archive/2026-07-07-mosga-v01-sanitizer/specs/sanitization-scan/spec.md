## ADDED Requirements

### Requirement: Structure-aware traversal of the session

The scanner SHALL traverse a `SanitizedSession` structure-aware, scanning every string-bearing position rather than a flattened blob: per message — `content`, `thinking`, `commandName`, `commandMessage`, `commandArgs`, each `toolCalls[].input` (serialized deterministically), each `toolCalls[].result`, and each `toolResults[].content`; per session — `cwd` and `title`. Tool-call results and command echoes (the design doc's highest-risk positions) SHALL be scanned, and system-role message `content` (system prompts) SHALL be scanned.

#### Scenario: A secret only in a tool-call result is found

- **WHEN** a fake secret appears solely in a `toolCalls[].result` string
- **THEN** the scanner produces a finding located at that tool call's result, not a whole-message match

#### Scenario: Tool-call input is scanned via canonical serialization

- **WHEN** a `toolCalls[].input` object contains a sensitive value
- **THEN** the scanner serializes the input canonically, finds the value, and records a `toolCallInput` location whose span indexes into that same canonical serialization

### Requirement: Precise structured finding locations

Each finding SHALL carry a structured `FindingLocation` — `scope` (`message`|`session`), `messageIndex`, `messageUuid` (the `ParsedMessage.sdkUuid`), `field`, optional `toolCallId`/`toolResultIndex`, and a `span` of char offsets in the resolved field string — not a flat document offset. The `messageUuid` SHALL make a finding stable across re-scans.

#### Scenario: Location round-trips to the exact substring

- **WHEN** a finding's location and span are resolved against the session
- **THEN** the indexed substring equals the matched text

#### Scenario: Same finding is stable across a re-scan

- **WHEN** the same session is scanned twice
- **THEN** a given hit yields the same `Finding.id` both times (so downstream dispositions survive a re-scan)

### Requirement: Three-layer detection with block-on-hit semantics

The scanner SHALL classify findings into three layers: L1 `secrets` (gitleaks rules), L2 `custom` (user rules), and L3 `normalization` (paths / usernames / emails / IPs). L1 and L2 findings SHALL be marked `blocking: true`; L3 findings SHALL be `blocking: false`. L1 detection SHALL honor the ingested rules' keyword pre-filter, entropy/`secretGroup` thresholds, and allowlists.

#### Scenario: Secret and custom hits are blocking

- **WHEN** a gitleaks rule and a custom rule each match
- **THEN** both findings have `blocking: true`

#### Scenario: Normalization hits are non-blocking

- **WHEN** an email or local path is detected
- **THEN** the finding has `blocking: false` and layer `normalization`

#### Scenario: Allowlisted example secret is suppressed

- **WHEN** content contains a known allowlisted example secret (e.g. the AWS docs key `AKIAIOSFODNN7EXAMPLE`)
- **THEN** no blocking finding is produced for it

### Requirement: Session-scoped deterministic pseudonym mapping

The scanner SHALL use a per-session `PseudonymMapper` that maps each `(category, original)` to a stable placeholder (e.g. `<PATH_1>`, `<EMAIL_1>`) assigned in first-encounter order within the session. The same original SHALL map to the same placeholder for the whole session, and the mapping SHALL be session-scoped and not persisted across sessions, so the same value maps to different placeholders in different sessions (defeating cross-session linking). L3 findings SHALL carry the mapper's placeholder as `replacementSuggestion`.

#### Scenario: Consistent within a session

- **WHEN** the same local path appears in three different messages of one session
- **THEN** all three findings suggest the same placeholder

#### Scenario: Inconsistent across sessions

- **WHEN** two different sessions each contain the same path but in different encounter orders
- **THEN** the placeholder assigned to that path differs between the two sessions

### Requirement: Findings/report model

The scanner SHALL produce a `SanitizationReport` containing `reportVersion`, `sanitizationRulesetVersion` (the compiled ruleset composite version), `sessionId`, `generatedAt`, the `findings[]`, a `layerSummary` (secrets/custom pending counts, normalization `byCategory` stats), `nonTextItems[]`, and a `gate` object. Secret/custom `matchPreview` SHALL be redacted (never the raw secret) because the report is persisted.

#### Scenario: Report carries per-layer summary

- **WHEN** a session with secrets, custom hits, and normalization hits is scanned
- **THEN** `layerSummary` reports the secrets/custom totals-and-pending and the normalization `byCategory` counts

#### Scenario: Secret preview is redacted

- **WHEN** a secret finding is serialized into the report
- **THEN** its `matchPreview` does not contain the full raw secret

### Requirement: Gate status computation

The report SHALL compute a `gate` where `unlocked` is true only when every `blocking` finding is dispositioned (not `pending`) AND every non-text item is dispositioned. L3 findings SHALL NOT affect `unlocked`. This function is pure; enforcement of the lock is a downstream (slice 3/4) concern.

#### Scenario: Locked while a blocking hit is pending

- **WHEN** at least one L1/L2 finding has disposition `pending`
- **THEN** `gate.unlocked` is false

#### Scenario: Unlocked when all blocking hits and non-text items are handled

- **WHEN** every L1/L2 finding and every non-text item has a non-`pending` disposition
- **THEN** `gate.unlocked` is true, regardless of L3 findings' dispositions

### Requirement: Non-text markers propagate as confirmation items

The scanner SHALL iterate EVERY message's `nonTextContent` marker — including markers the reader resolved onto a `tool_use`-carrying assistant message — and emit one `NonTextItem` per marked message (`messageIndex`, `messageUuid`, `blockTypes`, `disposition` defaulting to `pending`). The sanitizer SHALL NOT strip non-text content; it only surfaces it for per-item human confirmation.

#### Scenario: Image marker on a tool-call message becomes an item

- **WHEN** a message carrying `nonTextContent.blockTypes` including `image` is a tool_use-carrying assistant message
- **THEN** a `NonTextItem` is emitted for it with the `image` block type, and the message's content is not stripped

#### Scenario: Pending is the default non-text disposition

- **WHEN** non-text items are first produced
- **THEN** each has disposition `pending`, contributing to `gate.nonTextPending`
