## ADDED Requirements

### Requirement: Replay disposition application

`@mosga/sanitizer` SHALL expose `applyReplayDispositions` that accepts an immutable ReplayBundle draft, its matching `ReplaySanitizationReport`, and the replay-scoped pseudonym mapper. It SHALL clone the draft and honor each replay finding disposition: `replace` substitutes the exact span with `replacementSuggestion`, `delete` removes only the exact span, and `allow` retains it. Multiple edits in one string SHALL use deterministic offset-safe, outer-span-wins behavior.

#### Scenario: Native and instruction replacements apply together

- **WHEN** reviewed findings replace one sensitive span in a nested native string and another in an instruction file
- **THEN** both replacements appear in the cloned output and the input draft remains unchanged

#### Scenario: Delete preserves the containing structure

- **WHEN** a finding in a native string leaf is dispositioned `delete`
- **THEN** only the matched characters are removed while the row, field, containing objects/arrays, and sibling values remain present

### Requirement: Replay apply verifies report-to-draft identity

Before editing, replay apply SHALL verify that the report was produced for the supplied draft and ruleset and SHALL resolve every edited location against the unchanged original value. A missing file/row/pointer, changed original string, out-of-range span, mismatched draft identity, or invalid disposition SHALL return a stable error. It SHALL NOT silently ignore an edit or unlock the replay gate with sensitive source content left in place.

#### Scenario: Stale report is rejected

- **WHEN** a native row changes after scanning and the old report is applied
- **THEN** replay apply fails with a stale-location/draft error and produces no sealable payload

#### Scenario: Missing unknown field cannot no-op

- **WHEN** a replacement targets an unknown field that was removed after review
- **THEN** replay apply fails instead of treating the missing writer as a successful replacement

### Requirement: Source-native structure is preserved after replay apply

Replay apply SHALL retain native logical files, row count/order/ordinals, row types, all unrelated known and unknown fields, nested array order, scalar types, and structural reference values. Only explicitly dispositioned string spans and explicitly dispositioned opaque/non-text content SHALL differ. It SHALL not run normalized-message parsing, deduplication, scaffolding removal, tool-result merging, or source-row filtering.

#### Scenario: Codex context and mirror rows survive apply

- **WHEN** a Codex draft contains `session_meta`, `turn_context`, `response_item`, and `event_msg` rows and one message string is replaced
- **THEN** every row remains in its original position and only the reviewed string span differs

#### Scenario: Claude reference graph survives apply

- **WHEN** a Claude draft contains session, uuid, parentUuid, and tool-use/result references and an unrelated path is pseudonymized
- **THEN** all reference fields remain equal to their input values

### Requirement: Replay-wide pseudonyms remain consistent on apply

Replay apply SHALL use replacement suggestions from the single mapper associated with the report. Equal normalization values found across native rows, instruction files, and fixed metadata SHALL resolve to the same placeholder in the output. The mapper SHALL not be serialized into the bundle or reused for another session.

#### Scenario: Same original becomes one alias everywhere

- **WHEN** a fake username is batch-replaced in native, instruction, and metadata findings
- **THEN** every occurrence in the reviewed output contains the same session-scoped alias

### Requirement: Opaque-item decisions are explicit

Replay apply SHALL honor replay opaque/non-text dispositions only through explicit source-aware decisions. `keep` SHALL retain the captured value and record the decision; `remove` or `replace` SHALL perform the defined source-safe transformation and record an omission. A pending item SHALL remain unchanged for preview but SHALL keep the output ineligible for sealing. Replay apply SHALL never auto-strip opaque content.

#### Scenario: Pending image blocks sealing

- **WHEN** an image review item is still pending
- **THEN** replay apply may return a preview but marks it not sealable and does not remove the image automatically

#### Scenario: Explicit removal records omission

- **WHEN** a supported opaque payload is explicitly dispositioned `remove`
- **THEN** the source-safe sanitized output omits/replaces that payload and adds a reviewed omission record

### Requirement: Replay gate controls seal eligibility

Replay apply SHALL return a sealable reviewed payload only when the replay gate is unlocked, every edited location was applied successfully, the output validates against the draft schema, and a post-apply scan contains no surviving blocking canary from a `replace` or `delete` decision. The reviewed payload SHALL stamp ruleset/report/decision versions, redacted decisions, approval time, and `humanReviewPassed: true`. A locked or failed result SHALL not be accepted by `sealReplayBundle`.

#### Scenario: Resolved review produces sealable payload

- **WHEN** all blocking and opaque items are validly dispositioned and post-apply verification is clean
- **THEN** replay apply returns a schema-valid payload marked eligible for ReplayBundle sealing

#### Scenario: Surviving canary fails closed

- **WHEN** an invalid edit leaves an obviously fake blocking canary in canonical native or instruction bytes
- **THEN** post-apply verification rejects seal eligibility

### Requirement: Existing normalized apply remains compatible

Adding replay disposition application SHALL NOT change the behavior or exported types of `applyDispositions`, normalized-session batch helpers, stamping, or existing non-text handling. Shared edit primitives MUST keep existing sanitizer, daemon review, dataset export, and reconstructed direct-submit tests green.

#### Scenario: Existing SanitizedSession apply is unchanged

- **WHEN** an existing normalized session/report fixture is applied after replay apply is introduced
- **THEN** it produces the same stamped session, pseudonyms, and gate behavior as before

### Requirement: Replay apply tests exclude real data

Replay apply tests SHALL use only hand-crafted fake native rows, instruction content, rules, and canaries. They MUST verify cross-artifact replacement, stale-report refusal, unknown-field preservation, native-reference preservation, opaque-item gating, and absence of each replaced/deleted canary from both the reviewed payload and canonical serialized entries.

#### Scenario: Reviewed bytes contain no replaced canary

- **WHEN** fake secrets in all supported replay input positions are dispositioned `replace`
- **THEN** neither the sealable payload nor its canonical native/instruction bytes contain any original fake secret
