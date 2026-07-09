## MODIFIED Requirements

### Requirement: Render and gate on all blocking finding kinds

The findings view SHALL surface EVERY blocking finding, including the engine findings `ruleset-compile-error` and `redos-guard` (and any `field:'rulesetMeta'` finding), plus the scan's `rulesetWarnings[]` as a banner. A meta finding with no editable text SHALL be dispositionable via an acknowledge/allow affordance so it can be cleared from the gate; the UI SHALL NOT hide or auto-clear these.

#### Scenario: Compile-error finding is shown and blocks the gate

- **WHEN** a review contains a blocking `ruleset-compile-error` finding
- **THEN** the UI shows it as a blocking item requiring acknowledgement, and the gate stays locked (shown by the lock badge) until it is dispositioned

#### Scenario: Ruleset warnings are displayed

- **WHEN** the scan returned `rulesetWarnings`
- **THEN** the UI displays them as a visible banner, not hidden

### Requirement: Gate banner and signed confirmation summary

The UI SHALL keep the review LOCKED until `gate.unlocked` is true (every blocking finding and every non-text item dispositioned), presenting the locked/cleared state as a lock badge on the persistent stepper. Once cleared it SHALL present a signing confirmation — a ceremony card whose affirmation expresses "命中项已全部处置 + 含图记录已逐条确认 + 抽检通过" — that the user affirms to unlock the exit step. The exit/export controls SHALL be disabled while locked and while unsigned.

#### Scenario: Locked until all blocking + non-text handled

- **WHEN** any blocking finding or non-text item is still `pending`
- **THEN** the lock badge shows a locked/remaining state and the exit step is not enterable

#### Scenario: Signed summary gates the exit

- **WHEN** all items are dispositioned and the user affirms the signing confirmation
- **THEN** the exit step becomes enterable and the export/submit controls become enabled

### Requirement: Export preview of the sanitized envelope

Once the gate is unlocked and the sanitized export is produced, the UI SHALL present a human-readable summary of the stamped `SanitizedSession` (`meta.sanitized:true`, ruleset version stamped) as the primary content, with the raw JSON available only inside an expandable 「高级」 fold — never as the primary information carrier.

#### Scenario: Sanitized envelope summarized after unlock

- **WHEN** the user exports after unlocking
- **THEN** the UI shows a human-readable summary of the stamped `SanitizedSession`, with the raw JSON inside a collapsed Advanced fold

### Requirement: Cheap component-level UI tests

The package SHALL include component-level tests for the key interactions (disposition control, batch action, locked/signing state, non-text confirm) where they are cheap to write. A heavy end-to-end browser suite is out of scope. Structural reorganization of the tests to follow the journey components is expected; the behavioural contracts SHALL be preserved.

#### Scenario: Locked state renders from a fixture report

- **WHEN** a component test renders the journey (or its signing/lock component) with a report that has a pending blocking finding
- **THEN** the locked state is shown and the exit/export control is disabled
