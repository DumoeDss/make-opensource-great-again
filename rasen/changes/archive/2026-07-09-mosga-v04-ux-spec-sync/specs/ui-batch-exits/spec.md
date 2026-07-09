# ui-batch-exits Delta

## MODIFIED Requirements

### Requirement: Batch publish wizard over the batch routes

The batch 出口① SHALL be a three-step wizard (预检 → PR 预览 → 提交) over the daemon batch publish routes. The preview SHALL show the batch branch, a per-record table (sessionId, message count, record path, bytes), the PR body in a styled preformatted block, and the compare link when derived. A batch pre-check refusal SHALL list every refused session with rule-aggregated counts only and offer a per-session jump back that switches the queue to that review, focuses the named rule's group in step ②, and flows through the affirmation-void guard. When `gh` is not ready the submit step SHALL fall back to the staged locations + exact command sequence + compare URL with per-command copy. A successful batch submit SHALL mark the journey completed.

#### Scenario: Batch preview enumerates the records

- **WHEN** the batch plan succeeds for N sessions
- **THEN** the preview shows the batch branch and one table row per record (sessionId, messages, record path, bytes) plus the PR body and compare link

#### Scenario: Per-session refusal jumps back through the void guard

- **WHEN** the batch pre-check refuses two sessions and the user jumps to one refused session's rule
- **THEN** the queue switches to that review at step ② with the rule's group focused, and any disposition change there passes the affirmation-void confirm first

#### Scenario: gh-free batch fallback shows the manual path

- **WHEN** the user reaches the submit step with `gh` unavailable or unauthenticated and stages the batch
- **THEN** the wizard shows the staged file locations, the exact command sequence (ending in `gh pr create`), and the compare-URL browser fallback with per-command copy

#### Scenario: Batch publish completes the journey

- **WHEN** the one-click batch submit succeeds
- **THEN** the journey shows the exit step 已完成 with the receipt (branch, PR title, record count, compare URL when available)
