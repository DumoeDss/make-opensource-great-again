# ui-session-queue Specification

## Purpose
TBD - created by archiving change mosga-v04-session-picker. Update Purpose after archive.
## Requirements
### Requirement: Tree-navigation session picker

The picker SHALL present a two-pane layout: a left tree of sources (CLI types) and their projects, and a right session card grid for the selected project. Expanding a source SHALL lazy-load its projects (loaded once, cached). A project row SHALL show its short label plus a `recommended` badge, and SHALL expose the full working-directory path via a hover tooltip (native `title`). The whitelist defense SHALL be preserved: only `recommended` (public-git-remote) projects are listed by default, with an explicit show-all control at the tree top.

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

The journey container SHALL hold the review queue with per-item client-side signature state and a current index. A queue bar SHALL show 「会话 k/N」 plus each item's state (待处理 / 当前 / 已签署) and allow switching between items. Steps ②③ SHALL operate on the current item only; the lock badge and gate counts SHALL reflect the current item. Signing the current item SHALL auto-advance to the next unsigned item; step ④ SHALL become enterable only when EVERY item in the queue is signed. Editing a signed item's dispositions SHALL raise the signature-void confirm and, on confirm, void ONLY that item's signature (re-locking step ④). Leaving the journey with signed or in-progress items SHALL prompt a confirmation before discarding queue state.

#### Scenario: Signing advances to the next unsigned session

- **WHEN** the user signs session k and at least one queue item is still unsigned
- **THEN** the journey advances to the next unsigned item's disposition step, and the queue bar marks item k 已签署

#### Scenario: Exit step requires every session signed

- **WHEN** any queue item is unsigned
- **THEN** step ④ is not enterable; once the last item is signed the journey proceeds to step ④

#### Scenario: Editing a signed queue item voids only that item

- **WHEN** the user switches to a previously signed item and confirms a disposition change through the void dialog
- **THEN** that item's signature is voided and step ④ re-locks, while other items' signatures are untouched

#### Scenario: Abandoning the queue prompts a confirmation

- **WHEN** the user chooses to leave the journey (换会话) while queue items are signed or in progress
- **THEN** a confirm dialog warns that the queue's progress is discarded before returning to the picker

### Requirement: Transitional batch exit summary

While the batch exits are not yet wired (later slices), a queue of more than one signed session SHALL land on a transitional exit page: a summary list of the signed sessions, a per-item sanitized-file download (the existing gated export), and clearly disabled placeholder cards for the batch exits. A length-1 queue SHALL render the existing dual exit cards unchanged.

#### Scenario: Single-session queue keeps the dual exit cards

- **WHEN** a length-1 queue reaches step ④
- **THEN** the existing dual exit cards (出口①/出口② + secondary export) render exactly as before

#### Scenario: Multi-session queue shows the transitional summary

- **WHEN** a queue with N>1 signed sessions reaches step ④
- **THEN** the UI lists the signed sessions with per-item sanitized-file downloads and shows disabled batch-exit placeholder cards

