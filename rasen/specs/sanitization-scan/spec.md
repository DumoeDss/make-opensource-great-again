# sanitization-scan

## Purpose

Defines the `@mosga/sanitizer` scan engine: structure-aware traversal of a `SanitizedSession`, three-layer (secrets/custom/normalization) detection with block-on-hit semantics, session-scoped deterministic pseudonym mapping, the `SanitizationReport` model, and the pure gate computation.
## Requirements
### Requirement: Structure-aware traversal of the session

The scanner SHALL traverse a `SanitizedSession` structure-aware, scanning every string-bearing position rather than a flattened blob. Per message it SHALL scan `content`, `thinking`, `commandName`, `commandMessage`, `commandArgs`, each `toolCalls[].input` (serialized deterministically), each `toolCalls[].result`, and each `toolResults[].content`. Per session it SHALL scan the session identity and provenance envelope fields, not only `cwd` and `title`: `schemaVersion`; `meta.contributorAlias`, `meta.sourceCli`, `meta.toolVersion`, `meta.exportedAt`, and `meta.license`; and `session.sessionId`, `session.sourceId`, `session.projectKey`, `session.cwd`, `session.title`, and `session.updatedAt`. Tool-call results and command echoes (the design doc's highest-risk positions) SHALL be scanned, and system-role message `content` (system prompts) SHALL be scanned. A field that is `null`/absent SHALL be skipped; `session.updatedAt` (a number) SHALL be coerced to its string form before scanning.

#### Scenario: A secret only in a tool-call result is found

- **WHEN** a fake secret appears solely in a `toolCalls[].result` string
- **THEN** the scanner produces a finding located at that tool call's result, not a whole-message match

#### Scenario: Tool-call input is scanned via canonical serialization

- **WHEN** a `toolCalls[].input` object contains a sensitive value
- **THEN** the scanner serializes the input canonically, finds the value, and records a `toolCallInput` location whose span indexes into that same canonical serialization

#### Scenario: A secret planted in a session identity field is found

- **WHEN** a fake secret appears only in `session.projectKey`, `session.sessionId`, or `session.sourceId`
- **THEN** the scanner produces a blocking `secrets`-layer finding whose `location.field` names that field, so it contributes to `gate.blockingPending`

#### Scenario: A secret planted in a meta/schema field is found

- **WHEN** a fake secret appears only in `meta.toolVersion`, `meta.contributorAlias`, `meta.exportedAt`, `meta.license`, or top-level `schemaVersion`
- **THEN** the scanner produces a blocking finding whose `location.field` names that field, so the human review gate surfaces it and stays locked

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

### Requirement: Envelope-field scan coverage matches the publish-path raw-bytes backstop

The structured scan SHALL cover every string-bearing envelope field that a value could plausibly be planted in, so the human review gate — which consumes the structured `SanitizationReport` — no longer under-covers relative to the publisher's raw-bytes backstop (`scanRawBytesBackstop`). A blocking finding in any newly covered field SHALL be emitted with `location.scope: 'session'` and a `location.field` naming the field, and SHALL be `blocking: true` for `secrets`/`custom` layers so it locks the gate. Non-string envelope fields that cannot encode a secret as text — `meta.sanitized` (boolean) and any `null` field such as `meta.sanitizationRulesetVersion` out of readers — MAY be skipped by the structured scan; the byte-exact raw-bytes backstop remains their coverage.

#### Scenario: Structured gate sees what the byte backstop sees

- **WHEN** a session carries a fake secret in `session.projectKey` and is scanned
- **THEN** the structured report contains a blocking finding for it (so the human gate locks), matching what the publisher's raw-bytes backstop would independently catch at export

#### Scenario: ReDoS/oversize guards apply to newly covered fields

- **WHEN** a newly covered envelope field (e.g. `session.projectKey`) exceeds the scan-size cap or the per-field time budget
- **THEN** the same `redos-guard` blocking finding is emitted for that field rather than the field being silently skipped

### Requirement: Encoded project-key path is pseudonymized

`session.projectKey` is the on-disk project slug produced by encoding an absolute project path (non-alphanumeric characters mapped to `-`), so it embeds the OS username and project directory name in a dash-encoded form that the slash-anchored L3 path/username detectors do not match. When `session.projectKey` has the shape of an encoded home path (contains a `Users`/`home` segment), the scanner SHALL emit a non-blocking L3 `normalization` finding of category `path` covering the encoded slug, with the session-scoped `PseudonymMapper` placeholder (`<PATH_n>`) as its `replacementSuggestion` — the same non-blocking treatment `session.cwd` already receives. This recognition SHALL be scoped to the `projectKey` field only, never applied to arbitrary message text, so it cannot over-match prose.

#### Scenario: Encoded project-key slug gets a path pseudonym

- **WHEN** `session.projectKey` is `-Users-alice-acme-secret` (or `C--Users-alice-acme-secret`)
- **THEN** the scan emits a non-blocking L3 `path` finding over the slug whose `replacementSuggestion` is a `<PATH_n>` placeholder from the session mapper

#### Scenario: Project-key pseudonym is session-consistent

- **WHEN** the same encoded project-key value is present and the same path also appears in `session.cwd`
- **THEN** both resolve to the same session-scoped `<PATH_n>` placeholder (consistent within the session, and — by the mapper's first-encounter ordering — not linkable across sessions)

