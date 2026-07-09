# ui-session-queue Specification

## Purpose
TBD - created by archiving change mosga-v04-session-picker. Update Purpose after archive.
## Requirements
### Requirement: Tree-navigation session picker

The picker SHALL present a two-pane layout: a left tree of sources (CLI types) and their projects, and a right session card grid for the selected project. Expanding a source SHALL lazy-load its projects (loaded once, cached). A project row SHALL show its short label plus a `recommended` badge, and SHALL expose the full working-directory path via a hover tooltip (native `title`). The whitelist defense SHALL be preserved: only `recommended` (public-git-remote) projects are listed by default, with an explicit show-all control pinned to the BOTTOM of the tree pane (with the defense copy) so it does not scroll away and does not compete with the selection controls at the tree top.

#### Scenario: Expanding a source lazy-loads its projects

- **WHEN** the user expands a source group in the tree for the first time
- **THEN** the UI fetches that source's projects once and renders them as child rows with recommended badges

#### Scenario: Project row reveals the full path on hover

- **WHEN** the user hovers a project row whose label is a shortened form of its working directory
- **THEN** the full path is available via the row's tooltip (`title` attribute)

#### Scenario: Selecting a project shows its sessions as cards

- **WHEN** the user clicks a project row
- **THEN** the right pane loads and renders that project's sessions as a card grid

### Requirement: Session card grid with multi-select

The session grid SHALL render one card per session showing the title (truncated, with the full title available via a hover tooltip), a relative last-updated time (platform `Intl.RelativeTimeFormat`, no third-party dependency), and a humanized size. Clicking a card SHALL toggle its selection; the grid SHALL offer a select-all control scoped to the shown folder and a clear control that empties the ENTIRE cross-folder selection set. The selection set SHALL accumulate across folders and sources, keyed by `sourceId+projectKey+sessionId`, and SHALL be capped at 20 items with a visible hint when the cap is reached. A selection bar SHALL show the total selected count and the start-review call to action.

#### Scenario: Card click toggles selection

- **WHEN** the user clicks an unselected session card
- **THEN** the card becomes selected (visibly marked) and the selection bar count increments; clicking again deselects it

#### Scenario: Select-all selects the shown folder

- **WHEN** the user activates select-all with a project's sessions shown
- **THEN** all of that folder's sessions join the selection set, subject to the 20-item cap

#### Scenario: Selection accumulates across folders

- **WHEN** the user selects sessions in one project, then navigates to another project and selects more
- **THEN** the selection bar counts both folders' selections and starting the review includes all of them

#### Scenario: Selection cap is enforced with a hint

- **WHEN** the selection set holds 20 sessions and the user tries to add another
- **THEN** the addition is refused and the UI shows the cap hint (批量上限 20，请分批)

### Requirement: Queue creation from the selection

Starting the review SHALL create one daemon review per selected session, serially, with visible progress (正在扫描 k/N). When every creation succeeds the UI SHALL enter the journey with the resulting queue. When some creations fail, the UI SHALL list the failed sessions and let the user proceed with the successful remainder or return to the picker. A single selected session SHALL yield a length-1 queue whose journey is behaviourally identical to the single-session flow.

#### Scenario: Multi-select creates one review per session

- **WHEN** the user starts a review with N sessions selected
- **THEN** the UI serially POSTs N review creations, showing scan progress, and enters the journey holding an N-item queue

#### Scenario: Partial creation failure is recoverable

- **WHEN** one session's review creation fails while others succeed
- **THEN** the failed session is named with its error, and the user can continue the journey with the successfully created reviews

### Requirement: Per-session queue journey

The journey container SHALL hold the review queue with a current index (no per-session signature state). A queue bar SHALL show 「会话 k/N」 plus each item's TRIAGE state — 当前 (the open session) / 待处置 (pending>0, with a hit-count badge) / 无需处置 (pending===0) — and allow switching between items. Step ② SHALL operate on the current item; the lock badge and gate counts SHALL aggregate across the whole queue. The exit step SHALL become enterable only when EVERY session's gate is cleared. Donation confirmation is a single whole-queue dialog (see `ui-journey-shell`); editing any session's dispositions after the donation is affirmed SHALL raise the affirmation-void confirm and, on confirm, void the affirmation and re-lock the exit. Leaving the journey with progress (any mutation made, or affirmed) SHALL prompt a confirmation before discarding queue state.

#### Scenario: Signing advances to the next unsigned session

- **WHEN** the current session's blocking + non-text items all become dispositioned (e.g. via one-click cleanup) and at least one other session still has pending work
- **THEN** the journey auto-advances to the next session that still has pending items, and the queue bar marks cleared sessions 无需处置

#### Scenario: Exit step requires every session signed

- **WHEN** any queue session still has pending blocking or non-text items
- **THEN** the exit step is not enterable; once every session's gate is cleared the journey proceeds to the exit step

#### Scenario: Editing a signed queue item voids only that item

- **WHEN** the user changes a disposition in any session after affirming the donation and confirms the void dialog
- **THEN** the whole-queue affirmation is voided and the exit re-locks, and the daemon disposition call still runs

#### Scenario: Abandoning the queue prompts a confirmation

- **WHEN** the user chooses to leave the journey (换会话) after making any progress (a disposition mutation, or an affirmed donation)
- **THEN** a confirm dialog warns that the queue's progress is discarded before returning to the picker

### Requirement: One-click rule-based cleanup with per-session triage

The journey SHALL offer a one-click rule-based cleanup that replaces every CLEANABLE hit in a session with its pseudonym, where a cleanable hit is a finding that is pending, blocking, and NOT a meta/engine finding (`ruleset-compile-error`, `redos-guard`, or any `field:'rulesetMeta'`). Meta/engine hits and non-text (image/attachment) items SHALL be EXCLUDED from auto-cleanup — an engine degradation or an attachment must be reviewed by a human. The affordance count and the action SHALL derive from the same cleanable-findings definition so they never diverge. A session-level control SHALL clean the current session (one batch-by-rule call per distinct cleanable rule) and auto-advance (to the next session with pending work, or to the exit step when the whole queue is cleared); a queue-level control SHALL clean every session's cleanable hits and advance to the exit step when the whole queue clears.

#### Scenario: One-click cleanup replaces each cleanable rule once, skipping meta hits

- **WHEN** a session has pending blocking secret/custom hits plus a pending meta/engine hit and the user runs the session cleanup
- **THEN** each distinct non-meta rule is replaced in one batch-by-rule call, and the meta hit is never auto-disposed

#### Scenario: Cleanup auto-advances the queue

- **WHEN** the user runs the queue-level cleanup and every session becomes cleared
- **THEN** the journey advances to the exit step

### Requirement: Scoped tree selection checkboxes

The tree SHALL provide selection checkboxes at three scopes: a top-level 「选择全部项目」, one per source header, and one per project row. Ticking a scope SHALL select every session under it — fetching projects (respecting the show-all scope) and sessions as needed, adding to the cross-folder selection up to the 20-item cap, with the ticked checkbox showing a spinner while collecting. Unticking a scope SHALL remove that range from the selection by selection-key prefix, issuing NO requests. A scope's checkbox SHALL read as checked only when all of its (loaded) sessions are selected (no indeterminate state); not-yet-loaded nodes read as unchecked. The scope checkboxes SHALL NOT trigger the row's expand/open behaviour.

#### Scenario: Ticking a project selects all its sessions

- **WHEN** the user ticks a project's checkbox
- **THEN** the UI loads that folder's sessions (if not cached) and adds them all to the selection, subject to the 20-item cap

#### Scenario: Unticking removes by prefix with no requests

- **WHEN** the user unticks a source whose sessions were selected
- **THEN** those sessions are removed from the selection by prefix and no additional session requests are made

#### Scenario: Select-all-projects fans out and caps

- **WHEN** the user ticks 「选择全部项目」 and the visible scope holds more than 20 sessions across sources
- **THEN** sessions are collected across sources and added up to the 20-item cap, with the cap hint shown

