# ui-journey-shell Delta

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Signing ceremony card and client-side signature lifecycle

**Reason**: Superseded by the one-time donation confirmation dialog (see the ADDED `One-time donation affirmation before the first exit action` requirement). Signing is no longer a step or a per-session lifecycle: there is no signing card, no per-session signature, and no `已签署` badge state — confirmation is a single whole-queue dialog raised before the first exit action, and editing a disposition after confirming voids the affirmation.

## ADDED Requirements

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
