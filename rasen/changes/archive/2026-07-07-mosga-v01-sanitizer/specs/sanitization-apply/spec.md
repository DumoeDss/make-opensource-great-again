## ADDED Requirements

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
