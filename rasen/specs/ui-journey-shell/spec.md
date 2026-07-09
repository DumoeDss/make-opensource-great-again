# ui-journey-shell Specification

## Purpose
TBD - created by archiving change mosga-v03-ui-journey-shell. Update Purpose after archive.
## Requirements
### Requirement: NavRail application shell

`@mosga/ui` SHALL render an omnicross-style left NavRail shell containing the "MOSGA" logo + subtitle, navigation to two destinations — **贡献** (the review journey) and **设置** (settings) — and a footer showing the daemon address and health status. The content area SHALL render the active destination. The 历史 destination is out of scope for this slice.

#### Scenario: Shell renders with contribute and settings navigation

- **WHEN** the app loads
- **THEN** the NavRail shows the MOSGA logo, a 贡献 nav item, a 设置 nav item, and a daemon-status footer, with 贡献 active by default

#### Scenario: Settings navigation switches the content area

- **WHEN** the user activates the 设置 nav item
- **THEN** the content area shows the settings page and the 贡献 journey is not shown

#### Scenario: Daemon status footer reflects health

- **WHEN** the daemon health poll succeeds
- **THEN** the footer shows the daemon address and a healthy status; when the poll fails it shows an unhealthy/unreachable status

### Requirement: Persistent four-step stepper with lock badge

The 贡献 journey SHALL show a persistent stepper with three steps — ①选择会话, ②处置命中, ③选择出口 — marking the current and completed steps, alongside a lock badge with three states: `还差 N 项解锁` when any session's gate is locked (N = the pending blocking + pending non-text count summed across the WHOLE queue), `已解锁` when every session is cleared, and `已完成` after an exit action succeeds. Steps ②③ SHALL render as navigation buttons; step ③ 选择出口 is gated — not enterable until every session's gate has cleared. Step ① 选择会话 stays non-interactive display (returning to the picker is the header's 换会话 link).

#### Scenario: Lock badge counts down as items are dispositioned

- **WHEN** blocking or non-text items remain pending in any session
- **THEN** the lock badge shows `还差 N 项解锁` with N equal to the pending blocking + non-text count summed across the queue, decreasing as items are dispositioned

#### Scenario: Badge transitions through cleared, signed, completed

- **WHEN** every session's gate clears, then an exit action succeeds
- **THEN** the badge shows `已解锁`, then `已完成` in turn

#### Scenario: Later steps are gated

- **WHEN** any session's gate is still locked
- **THEN** step ③ 选择出口 is not enterable; once every session is cleared it becomes enterable

### Requirement: Merged disposition workspace

Step ② SHALL merge the former blocking / non-text / Layer-3 tabs into a single workspace: a left group navigation (密钥命中, 自定义规则, 图像/附件, 归一化统计) with per-group counts and a right disposition queue for the selected group. The per-hit and batch disposition logic of the existing findings/non-text/Layer-3 views SHALL be reused unchanged. Batch operations SHALL be surfaced as queue-top suggestion cards. The 归一化统计 group SHALL NOT gate: its items impose no blocking disposition obligations and SHALL NOT count toward the lock badge (statistics + spot-check presentation; the pre-existing batch-by-type normalization control is retained unchanged).

#### Scenario: Groups route to their queues

- **WHEN** the user selects the 密钥命中 group, then the 图像/附件 group
- **THEN** the right queue shows that group's items with their existing per-hit disposition controls

#### Scenario: Batch suggestion applies a rule group in one action

- **WHEN** a batch suggestion card for a rule with multiple hits is actioned
- **THEN** the daemon batch endpoint is called for that rule and the queue + lock badge update

#### Scenario: Normalization group does not gate

- **WHEN** the 归一化统计 group is viewed
- **THEN** it shows category counts and a sampled spot-check only, contributes no disposition, and does not change the lock badge count

### Requirement: Dual exit cards with secondary export and receipt completion

Step ④ SHALL present two equal exit cards. 出口①「公开数据集」SHALL be a readiness-state placeholder describing the publish flow with its wizard deferred to a later slice (no daemon publish call in this slice). 出口②「API 直投」SHALL preserve every existing direct-submit semantic (target/model/mode selection, cost estimate, dual acknowledgment, submit) and render its receipt as a summary card. A low-key secondary action 「仅导出脱敏文件」SHALL preserve the existing sanitized-export capability. The receipt view SHALL be step ④'s completion state (stepper all complete, badge `已完成`), not a fifth step.

#### Scenario: Both exits are presented as equals

- **WHEN** step ④ is reached
- **THEN** 出口① and 出口② are shown as two equal cards, plus a low-key 「仅导出脱敏文件」 secondary action

#### Scenario: Exit-1 is a readiness placeholder in this slice

- **WHEN** the 出口① card is shown
- **THEN** it describes the publish flow and does not invoke any daemon publish route (the wizard arrives in the publish slice)

#### Scenario: Direct-submit receipt completes the journey

- **WHEN** a 出口② submission succeeds
- **THEN** the receipt is shown as a summary card and the badge shows `已完成`

### Requirement: Settings page with three-state theme toggle and daemon status

The 设置 page SHALL provide a three-state theme toggle (light / dark / system) that drives the `.dark` class and persists the choice, replacing the follow-system-only bootstrap; the `system` option SHALL track `prefers-color-scheme`. It SHALL also show the daemon address + health and the list of targetable provider targets from the providers endpoint. The allowlisted vendor **presets** SHALL be shown without an edit control (they are fixed source-vendor targets). The page SHALL additionally let the user **add, edit, and delete custom providers** (name, `apiBaseUrl`, `models`, and an `apiFormat` chosen from openai / openai-response / anthropic / gemini) and **set or clear a provider API key** for a targetable provider. Key entry SHALL be write-only: the page SHALL show only a `configured` / `not configured` status per provider and SHALL NEVER display, prefill, or echo any stored key bytes, and SHALL disclose that a submitted key is stored encrypted at rest in a local user-scope file. The data-repository path remains startup-config only and out of scope for editing here.

#### Scenario: Theme toggle switches and persists

- **WHEN** the user selects `dark`, then reloads
- **THEN** the `.dark` class is applied and the dark choice persists across reload

#### Scenario: System option follows the OS preference

- **WHEN** the user selects `system`
- **THEN** the theme tracks `prefers-color-scheme` and updates live when the OS preference changes

#### Scenario: Provider targets shown read-only

- **WHEN** the settings page loads
- **THEN** it lists the targetable provider targets from the providers endpoint without exposing any key material, and the vendor presets are shown without an edit control

#### Scenario: Custom provider can be added, edited, and removed

- **WHEN** the user adds a custom provider with an apiFormat chosen from the four supported formats, then edits and deletes it
- **THEN** each change calls the corresponding custom-provider route and the settings list updates to reflect it

#### Scenario: Key entry is write-only and never echoed

- **WHEN** the user sets a key for a provider and later revisits the settings page
- **THEN** the page shows only a configured status for that provider, never the key value, and offers set/clear actions with an at-rest-encryption storage disclosure

### Requirement: Raw JSON demoted to advanced folds

No raw JSON SHALL be the primary information carrier in the review UI. The sanitized-export preview and the direct-submit receipt SHALL present human-readable summaries as primary content, with the raw `SanitizedSession` / receipt JSON available only inside an expandable 「高级」 fold.

#### Scenario: Export preview leads with a summary

- **WHEN** the sanitized export is previewed
- **THEN** a human-readable summary is primary and the raw JSON is inside a collapsed Advanced fold

#### Scenario: Receipt leads with a summary

- **WHEN** a submission receipt is shown
- **THEN** key fields are summarized as a card and the raw receipt JSON is inside a collapsed Advanced fold

### Requirement: One-time donation affirmation before the first exit action

Donation confirmation SHALL be a single dialog, raised the FIRST time the user triggers any exit action (publish, direct submit, or export — single or batch). The dialog SHALL present an aggregate summary across ALL sessions in the queue (session count, total replace/delete/allow disposition counts, non-text keep/exclude totals, normalization totals) and the affirmation "命中项已全部处置 + 含图记录已逐条确认 + 抽检通过". Confirming SHALL mark the queue affirmed and immediately run the deferred exit action; cancelling SHALL discard the pending action and run nothing. Once affirmed, subsequent exit actions SHALL proceed without re-confirming. Changing ANY disposition after affirming SHALL raise a void-confirm dialog and, on confirm, void the affirmation and re-lock the exit. The server gate's 409 remains the final backstop.

#### Scenario: First exit action raises the confirmation dialog

- **WHEN** the queue is cleared and the user triggers an exit action for the first time
- **THEN** the donation confirmation dialog appears with the whole-queue aggregate summary, and the exit action has not yet run

#### Scenario: Confirming runs the deferred action; a second action skips the dialog

- **WHEN** the user confirms the dialog, then later triggers another exit action
- **THEN** the first action runs on confirm, and the later action proceeds directly without re-showing the dialog

#### Scenario: Cancelling runs nothing

- **WHEN** the user cancels the confirmation dialog
- **THEN** the deferred exit action does not run and the queue stays unaffirmed

#### Scenario: Editing after affirming voids the affirmation

- **WHEN** the user changes a disposition after affirming and confirms the void warning
- **THEN** the affirmation is voided, the exit re-locks, and the daemon disposition call still runs

