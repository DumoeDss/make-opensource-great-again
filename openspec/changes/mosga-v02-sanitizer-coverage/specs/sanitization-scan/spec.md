## MODIFIED Requirements

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

## ADDED Requirements

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
