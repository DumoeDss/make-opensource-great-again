# ui-batch-exits Specification

## Purpose
TBD - created by archiving change mosga-v04-batch-exits-ui. Update Purpose after archive.
## Requirements
### Requirement: Batch exit page for multi-session queues

A queue of more than one signed session SHALL land on a batch exit page presenting the two exits as equal cards — 出口①「公开数据集（批量）」 driven by the publish preflight states, and 出口②「API 直投（批量）」 — plus a low-key batch export secondary action (per-item sanitized-file download and download-all, gated exports only, serialized byte-identically to the publisher's record file contents). A length-1 queue SHALL keep the existing single-session dual exit cards and flows unchanged.

#### Scenario: Multi-session queue shows dual batch exit cards

- **WHEN** a queue with N>1 signed sessions reaches step ④
- **THEN** the page shows the 出口① batch card (preflight-driven state) and the 出口② batch card as equals, with the batch export as a secondary action

#### Scenario: Single-session queue keeps the single-session exits

- **WHEN** a length-1 queue reaches step ④
- **THEN** the existing single-session exit cards, publish wizard, and submit panel render unchanged

#### Scenario: Batch export downloads each gated export

- **WHEN** the user invokes download-all on N signed sessions
- **THEN** each file comes from that review's gated export (a refused export shows an inline per-item error and downloads nothing for it)

### Requirement: Batch publish wizard over the batch routes

The batch 出口① SHALL be a three-step wizard (预检 → PR 预览 → 提交) over the daemon batch publish routes. The preview SHALL show the batch branch, a per-record table (sessionId, message count, record path, bytes), the PR body in a styled preformatted block, and the compare link when derived. A batch pre-check refusal SHALL list every refused session with rule-aggregated counts only and offer a per-session jump back that switches the queue to that review, focuses the named rule's group in step ②, and flows through the signature-void guard. When `gh` is not ready the submit step SHALL fall back to the staged locations + exact command sequence + compare URL with per-command copy. A successful batch submit SHALL mark the journey completed.

#### Scenario: Batch preview enumerates the records

- **WHEN** the batch plan succeeds for N sessions
- **THEN** the preview shows the batch branch and one table row per record (sessionId, messages, record path, bytes) plus the PR body and compare link

#### Scenario: Per-session refusal jumps back through the void guard

- **WHEN** the batch pre-check refuses two sessions and the user jumps to one refused session's rule
- **THEN** the queue switches to that review at step ② with the rule's group focused, and any disposition change there passes the signature-void confirm first

#### Scenario: gh-free batch fallback shows the manual path

- **WHEN** the user reaches the submit step with `gh` unavailable or unauthenticated and stages the batch
- **THEN** the wizard shows the staged file locations, the exact command sequence (ending in `gh pr create`), and the compare-URL browser fallback with per-command copy

#### Scenario: Batch publish completes the journey

- **WHEN** the one-click batch submit succeeds
- **THEN** the journey shows step ④ 已完成 with the receipt (branch, PR title, record count, compare URL when available)

### Requirement: Batch direct submit with aggregate estimate and per-item consent

The batch 出口② SHALL take ONE provider/model/replay-mode selection, sequentially estimate every review through the existing per-review estimate endpoint, and present the aggregate (total tokens, total estimated cost, session count) with per-item detail in a fold. ONE dual acknowledgment (ToS risk + full retention) SHALL gate the batch run; each review SHALL then be submitted with its OWN consent record bound to that review's content hash. The run SHALL show per-item progress and results, keep going past individual failures, and offer per-item retry. Changing the provider, model, or mode SHALL invalidate every shown estimate and the acknowledgments' effect.

#### Scenario: Aggregate estimate sums the batch

- **WHEN** the user estimates a 3-session batch
- **THEN** the panel shows the summed tokens and cost and the count 3, with each session's estimate available in a fold

#### Scenario: Each submission carries its own content-bound consent

- **WHEN** the batch run submits session k
- **THEN** the consent record sent for k carries k's own content hash and the acknowledged flags, never another session's hash

#### Scenario: A failed item does not stop the batch

- **WHEN** session 2 of 3 fails to submit
- **THEN** sessions 1 and 3 still complete, session 2 shows its error with a retry action, and the journey completes only per the successful receipts shown

#### Scenario: Target change invalidates estimates

- **WHEN** the user changes the provider, model, or replay mode after estimating
- **THEN** all shown estimates are cleared and the batch run is blocked until the batch is re-estimated (the acknowledgments gate the run as before; consents re-bind to the fresh estimates' hashes)

