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

The 贡献 journey SHALL show a persistent stepper with four steps — ①选择会话, ②处置命中, ③签署确认, ④选择出口 — marking the current and completed steps, alongside a lock badge with four states: `还差 N 项解锁` when the gate is locked (N = pending blocking + pending non-text), `已解锁` when cleared but unsigned, `已签署` after signing, and `已完成` after an exit action succeeds. Steps ③ and ④ SHALL be gated: ③ is not enterable until the gate clears, and ④ is not enterable until the user has signed.

#### Scenario: Lock badge counts down as items are dispositioned

- **WHEN** blocking or non-text items remain pending
- **THEN** the lock badge shows `还差 N 项解锁` with N equal to the pending blocking + non-text count, decreasing as items are dispositioned

#### Scenario: Badge transitions through cleared, signed, completed

- **WHEN** the gate clears, then the user signs, then an exit action succeeds
- **THEN** the badge shows `已解锁`, then `已签署`, then `已完成` in turn

#### Scenario: Later steps are gated

- **WHEN** the gate is still locked
- **THEN** step ③ is not enterable; and when cleared but unsigned, step ④ is not enterable

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

### Requirement: Signing ceremony card and client-side signature lifecycle

Step ③ SHALL be greyed and unenterable until the gate clears. Once cleared it SHALL surface a signing card with a serif (Georgia display) title 「数据捐赠确认」, a disposition summary (replace/delete/allow counts, non-text confirm counts, Layer-3 stats + spot-check conclusion), the existing signed-summary affirmation text, and a sign button that unlocks step ④. Signing SHALL be client-side state: it is lost on refresh, and changing any disposition after signing SHALL void the signature and re-lock step ④, guarded by a confirmation dialog. The server gate's 409 remains the final backstop.

#### Scenario: Signing card appears only after the gate clears

- **WHEN** any blocking or non-text item is still pending
- **THEN** step ③ is not enterable and the signing card is not actionable; when all are dispositioned, the signing card becomes available

#### Scenario: Signing unlocks the exit

- **WHEN** the user affirms the summary and signs
- **THEN** the lock badge shows `已签署` and step ④ becomes enterable

#### Scenario: Editing a disposition after signing voids the signature

- **WHEN** a signed user changes a disposition and confirms the void warning
- **THEN** the signature is dropped, step ④ re-locks, and the daemon disposition call still runs

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

The 设置 page SHALL provide a three-state theme toggle (light / dark / system) that drives the `.dark` class and persists the choice, replacing the follow-system-only bootstrap; the `system` option SHALL track `prefers-color-scheme`. It SHALL also show the daemon address + health and a read-only list of configured provider targets from the existing providers endpoint. The data-repository path and preflight-driven provider-key status are out of scope for this slice.

#### Scenario: Theme toggle switches and persists

- **WHEN** the user selects `dark`, then reloads
- **THEN** the `.dark` class is applied and the dark choice persists across reload

#### Scenario: System option follows the OS preference

- **WHEN** the user selects `system`
- **THEN** the theme tracks `prefers-color-scheme` and updates live when the OS preference changes

#### Scenario: Provider targets shown read-only

- **WHEN** the settings page loads
- **THEN** it lists the configured provider targets from the providers endpoint without exposing any key material and without an edit control

### Requirement: Raw JSON demoted to advanced folds

No raw JSON SHALL be the primary information carrier in the review UI. The sanitized-export preview and the direct-submit receipt SHALL present human-readable summaries as primary content, with the raw `SanitizedSession` / receipt JSON available only inside an expandable 「高级」 fold.

#### Scenario: Export preview leads with a summary

- **WHEN** the sanitized export is previewed
- **THEN** a human-readable summary is primary and the raw JSON is inside a collapsed Advanced fold

#### Scenario: Receipt leads with a summary

- **WHEN** a submission receipt is shown
- **THEN** key fields are summarized as a card and the raw receipt JSON is inside a collapsed Advanced fold

