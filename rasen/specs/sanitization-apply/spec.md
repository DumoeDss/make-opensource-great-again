# sanitization-apply

## Purpose

Defines the `@mosga/sanitizer` apply engine: turning a scanned `SanitizationReport` with human dispositions into a new, structurally isomorphic, schema-valid sanitized session, gated so an export-ready session can never be emitted while a blocking finding or non-text item is unresolved.
## Requirements
### Requirement: Per-hit disposition application

The apply engine SHALL take a `SanitizedSession`, its `SanitizationReport` (with dispositions set), and the session's `PseudonymMapper`, and produce a new `SanitizedSession` honoring each finding's disposition: `replace` substitutes the span with the finding's `replacementSuggestion`; `delete` removes the span; `allow` leaves it unchanged. The engine SHALL NOT mutate the input session in place.

#### Scenario: Replace substitutes the placeholder

- **WHEN** a finding with disposition `replace` is applied
- **THEN** the output session has the matched span replaced by the finding's `replacementSuggestion` and the input session is unchanged

#### Scenario: Allow leaves content intact

- **WHEN** a finding with disposition `allow` is applied
- **THEN** the matched text is unchanged in the output

### Requirement: Offset-safe multi-hit application

When multiple findings target the same field string, the engine SHALL apply edits so that earlier findings' spans remain valid (e.g. applying in descending start-offset order or rebuilding the string). Edits to a `toolCallInput` SHALL be applied to the canonical serialized form and re-parsed back into the `toolCalls[].input` object.

#### Scenario: Two hits in one string both apply correctly

- **WHEN** a single `content` string has two non-overlapping findings both dispositioned `replace`
- **THEN** both spans are replaced correctly with no offset corruption

#### Scenario: Tool-call input edit round-trips to an object

- **WHEN** a `toolCallInput` finding is replaced
- **THEN** the output `toolCalls[].input` is a valid object with the sensitive value replaced

### Requirement: Batch disposition using the shared pseudonym mapping

The engine SHALL support batch dispositions: `batch-by-rule` sets one disposition across all findings sharing a `ruleId`, and `batch-by-type` across all findings sharing an L3 `category`. Batch `replace` SHALL reuse the deterministic pseudonym mapping so identical originals collapse to the identical placeholder.

#### Scenario: Batch-by-type replaces all emails consistently

- **WHEN** the user batch-replaces all `email` findings
- **THEN** every email hit is replaced, and two occurrences of the same email get the same placeholder

#### Scenario: Batch-by-rule replaces every hit of one gitleaks rule

- **WHEN** the user batch-replaces all findings of a given gitleaks `ruleId`
- **THEN** every hit of that rule across the session is replaced in one operation

### Requirement: Block-on-hit gate is enforced before an export-ready session is emitted

The engine SHALL treat any `blocking` finding with disposition `pending` as unresolved: it SHALL NOT emit an export-ready (`meta.sanitized: true`) session while `gate.unlocked` is false. It MAY produce a partially-applied session for preview, but the sanitized/stamped result is only produced once all blocking findings and non-text items are dispositioned.

#### Scenario: Refuses to stamp while blocking hits pending

- **WHEN** apply is asked to produce the sanitized session while an L1/L2 finding is still `pending`
- **THEN** it does not emit a `meta.sanitized: true` session (it signals the gate is locked)

#### Scenario: Stamps once the gate is unlocked

- **WHEN** all blocking findings and non-text items are dispositioned and apply runs
- **THEN** it emits a `meta.sanitized: true` session

### Requirement: Stamped sanitized session output

The emitted export-ready session SHALL set `meta.sanitized = true`, `meta.sanitizationRulesetVersion` to the compiled ruleset composite version that produced the report, `session.cwd` and `session.title` normalized via the pseudonym mapping, and `meta.contributorAlias` from the mapper's primary-username placeholder. The `messages` SHALL remain structurally isomorphic to the input (only string values change) so 出口② replay stays possible.

#### Scenario: Envelope stamps carry the ruleset version

- **WHEN** the sanitized session is emitted
- **THEN** `meta.sanitized` is true and `meta.sanitizationRulesetVersion` equals the report's `sanitizationRulesetVersion`

#### Scenario: Structure is preserved

- **WHEN** the sanitized session is produced
- **THEN** the message count, message ordering, tool-call structure, and `schemaVersion` are unchanged from the input — only sensitive string spans differ

### Requirement: Non-text is never stripped by apply

The engine SHALL NOT strip non-text content. It SHALL honor `NonTextItem` dispositions (`keep` retains, `remove` drops that message's non-text presence per explicit user choice) with `keep`-and-confirm as the default, and SHALL never remove non-text content on its own initiative.

#### Scenario: Kept non-text survives apply

- **WHEN** a non-text item is dispositioned `keep`
- **THEN** the message's non-text marker/content is retained in the output

#### Scenario: Apply never auto-strips

- **WHEN** a non-text item is left at its default (not `remove`)
- **THEN** apply does not drop the non-text content

### Requirement: Canary and false-positive test guarantees

The package SHALL include tests proving detection quality against hand-crafted fake data only. Fake canary secrets (obviously-fake AWS, GitHub, and generic high-entropy patterns) placed at multiple structural positions (content, thinking, tool-call input, tool-call result) MUST all be caught as blocking findings. Named false positives (e.g. the AWS docs example key) MUST NOT be flagged as blocking.

#### Scenario: Canary secrets caught at every position

- **WHEN** the scan runs over a fixture with a fake AWS key in a tool result, a fake GitHub token in message content, and a generic fake secret in thinking
- **THEN** each is reported as a blocking finding at its correct location

#### Scenario: Documented false positive is not flagged

- **WHEN** the scan runs over a fixture containing the AWS docs example key
- **THEN** no blocking finding is produced for it

#### Scenario: No real secrets in fixtures

- **WHEN** the test suite runs
- **THEN** every secret in every fixture is an obviously-fake, non-functional value, and no real session data is read

### Requirement: Disposition application covers session identity fields

The apply engine SHALL be able to read and write the session identity/provenance string fields the widened scan now covers — `schemaVersion`, `session.sessionId`, `session.sourceId`, `session.projectKey`, and the `meta` string fields `contributorAlias`/`sourceCli`/`toolVersion`/`exportedAt`/`license` — so that a human `replace` or `delete` disposition of a finding in one of those fields is actually applied to the output session. A `replace`/`delete` disposition on a covered field SHALL NOT silently no-op (which would unlock the gate while leaving the raw value — a real secret — in the exported bytes). Fields that are not strings (`session.updatedAt` number, `meta.sanitized` boolean) have no writer; a finding on them is acknowledge-only.

#### Scenario: Replacing a secret found in projectKey lands in the output

- **WHEN** a finding in `session.projectKey` is dispositioned `replace`
- **THEN** the output session's `session.projectKey` has the matched span replaced and the input session is unchanged

#### Scenario: Encoded project-key path pseudonymizes on apply

- **WHEN** the non-blocking L3 `path` finding over an encoded `session.projectKey` slug is dispositioned `replace`
- **THEN** the output `session.projectKey` is the `<PATH_n>` placeholder, so the username/project directory embedded in the slug is not exported

### Requirement: Provenance fields are never auto-mutated by sanitization

The apply engine SHALL NOT sanitize or rewrite provenance on its own initiative. It edits a covered field only when a human sets an explicit `replace`/`delete` disposition on a finding in that field; under normal operation these tool-controlled fields carry no findings and pass through byte-identical. The two authoritative stamps — `meta.sanitizationRulesetVersion` and `meta.contributorAlias` — SHALL continue to be written only by the stamping step at gate-unlock (from the report's ruleset version and the mapper's primary alias), which is the intended provenance-writing mechanism, not a sanitization edit. The publisher-side `sanitizerPackageVersion` is not part of the `SanitizedSession` envelope, is never scanned or mutated here, and remains authoritative at publish time.

#### Scenario: Untouched provenance passes through unchanged

- **WHEN** a session with no findings in its provenance fields is applied and stamped
- **THEN** `meta.toolVersion`, `meta.exportedAt`, `meta.sourceCli`, `session.sourceId`, and `schemaVersion` are byte-identical to the input, and only `meta.sanitized`, `meta.sanitizationRulesetVersion`, and `meta.contributorAlias` are set by the stamp

#### Scenario: Stamp overrides any human edit to the stamped fields

- **WHEN** apply runs and the gate is unlocked
- **THEN** `meta.sanitizationRulesetVersion` equals the report's ruleset version and `meta.contributorAlias` equals the mapper's primary-username placeholder, regardless of any disposition set on those fields

