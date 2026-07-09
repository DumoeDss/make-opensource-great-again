# review-ui Delta

## MODIFIED Requirements

### Requirement: Gate banner and signed confirmation summary

The UI SHALL keep the review LOCKED until `gate.unlocked` is true (every blocking finding and every non-text item dispositioned), presenting the locked/cleared state as a lock badge on the persistent stepper. The exit/export controls SHALL be disabled while locked. Donation confirmation SHALL be a SINGLE dialog raised before the FIRST exit action (not a per-session step): its summary aggregates the disposition counts across ALL sessions in the queue, and its affirmation expresses "命中项已全部处置 + 含图记录已逐条确认 + 抽检通过". Confirming the dialog SHALL let the deferred exit action proceed; once affirmed, subsequent exit actions proceed directly until a disposition edit voids the affirmation. The server gate's 409 remains the final backstop.

#### Scenario: Banner locked until all blocking + non-text handled

- **WHEN** any blocking finding or non-text item is still `pending`
- **THEN** the lock badge shows a locked/remaining state and the exit step is not enterable

#### Scenario: Signed summary gates export

- **WHEN** all items are dispositioned and the user triggers an exit action (publish, submit, or export)
- **THEN** the one-time donation confirmation dialog appears with the whole-queue aggregate summary, and the exit action runs only after the user confirms it
