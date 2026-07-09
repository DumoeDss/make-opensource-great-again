## ADDED Requirements

### Requirement: Whitelist project and session picker

The `@mosga/ui` package SHALL provide a React 18 + Vite + Tailwind interface whose entry flow is a picker: choose a source, then a project, then a session. The project list SHALL default to `recommended` (public-git-remote) projects, with an explicit "show all projects" control to reveal the rest, surfacing the design doc's whitelist defense to the user.

#### Scenario: Recommended projects shown by default

- **WHEN** the picker loads a source's projects
- **THEN** only `recommended` projects are shown until the user opts into showing all

#### Scenario: Selecting a session starts a review

- **WHEN** the user selects a session
- **THEN** the UI creates a review via the daemon and transitions to the findings view once the scan returns

### Requirement: Findings table with per-hit dispositions

The UI SHALL present the scan's findings in a table showing at least layer, rule id, structural position (from `location`), and the redacted `matchPreview`, with a per-hit control to set disposition to `replace`, `delete`, or `allow`. Setting a disposition SHALL call the daemon and reflect the recomputed report.

#### Scenario: Disposition control updates a finding

- **WHEN** the user sets a finding to `replace`
- **THEN** the UI calls the daemon and shows the finding as dispositioned with the updated gate counts

#### Scenario: Redacted preview is shown, never a raw secret

- **WHEN** a secret/custom finding is displayed
- **THEN** the UI shows its redacted `matchPreview` and never a raw secret value

### Requirement: One-click batch dispositions

The UI SHALL provide one-click batch actions to disposition all findings sharing a rule (batch-by-rule) or all Layer-3 findings sharing a category (batch-by-type), delegating to the daemon's batch endpoints. Because batch replace reuses the deterministic pseudonym mapping, identical originals collapse to the identical placeholder.

#### Scenario: Batch-replace all emails in one click

- **WHEN** the user clicks batch-replace for the `email` category
- **THEN** every email finding becomes `replace` in one request and the table + gate update accordingly

### Requirement: Render and gate on all blocking finding kinds

The findings view SHALL surface EVERY blocking finding, including the engine findings `ruleset-compile-error` and `redos-guard` (and any `field:'rulesetMeta'` finding), plus the scan's `rulesetWarnings[]` as a banner. A meta finding with no editable text SHALL be dispositionable via an acknowledge/allow affordance so it can be cleared from the gate; the UI SHALL NOT hide or auto-clear these.

#### Scenario: Compile-error finding is shown and blocks the gate

- **WHEN** a review contains a blocking `ruleset-compile-error` finding
- **THEN** the UI shows it as a blocking item requiring acknowledgement, and the gate banner stays locked until it is dispositioned

#### Scenario: Ruleset warnings are displayed

- **WHEN** the scan returned `rulesetWarnings`
- **THEN** the UI displays them as a visible banner, not hidden

### Requirement: Per-item non-text confirmation

The UI SHALL list each non-text ⚠ item (from `nonTextItems`) individually, showing its block type(s) and message location/context, with per-item confirm (`keep`) / exclude (`remove`) actions delegating to the daemon. Rendering actual image bytes is NOT required for v0.1.

#### Scenario: Non-text item confirmed per item

- **WHEN** the user confirms (keeps) a non-text item
- **THEN** the daemon records `keep`, the item counts as dispositioned, and `gate.nonTextPending` decreases

#### Scenario: Non-text item on a tool-call message is shown

- **WHEN** a non-text marker was resolved onto a tool_use-carrying assistant message
- **THEN** the UI still lists that item at its message with its block type, so it can be confirmed

### Requirement: Gate banner and signed confirmation summary

The UI SHALL show a gate banner that stays LOCKED until `gate.unlocked` is true (every blocking finding and every non-text item dispositioned), and SHALL present a signed confirmation summary expressing "命中项已全部处置 + 含图记录已逐条确认 + 抽检通过" that the user affirms to unlock export. Export controls SHALL be disabled while locked.

#### Scenario: Banner locked until all blocking + non-text handled

- **WHEN** any blocking finding or non-text item is still `pending`
- **THEN** the gate banner shows locked and the export control is disabled

#### Scenario: Signed summary gates export

- **WHEN** all items are dispositioned and the user affirms the signed confirmation summary
- **THEN** the export control becomes enabled

### Requirement: Layer-3 statistics and sample-check view

The UI SHALL present Layer-3 normalization as a statistics view (`layerSummary.normalization.byCategory` counts) plus a sampled spot-check of normalization findings, rather than requiring per-item disposition of every L3 hit (L3 does not gate).

#### Scenario: L3 shown as stats plus a sample

- **WHEN** the L3 view is opened
- **THEN** it shows per-category counts and a sample of normalization findings for spot-checking, and the gate does not require each L3 hit to be dispositioned

### Requirement: Export preview of the sanitized envelope

Once the gate is unlocked and export is confirmed, the UI SHALL show a preview of the stamped sanitized `SanitizedSession` JSON returned by the daemon's export endpoint (`meta.sanitized:true`, ruleset version stamped).

#### Scenario: Sanitized envelope previewed after unlock

- **WHEN** the user exports after unlocking
- **THEN** the UI displays the stamped `SanitizedSession` JSON from the daemon

### Requirement: Cheap component-level UI tests

The package SHALL include component-level tests for the key interactions (disposition control, batch action, gate-locked state, non-text confirm) where they are cheap to write. A heavy end-to-end browser suite is out of scope for v0.1.

#### Scenario: Gate-locked state renders from a fixture report

- **WHEN** a component test renders the gate banner with a report that has a pending blocking finding
- **THEN** the banner shows locked and the export control is disabled
