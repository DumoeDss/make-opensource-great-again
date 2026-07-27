# ui-batch-exits Specification

## Purpose
TBD - created by archiving change mosga-v04-batch-exits-ui. Update Purpose after archive.
## Requirements
### Requirement: Batch exit page for multi-session queues

A queue of more than one signed session SHALL land on a batch exit page presenting the two exits as equal cards: exit ① public GitHub contribution driven by the daemon's discriminated publication status and exit ② batch API direct submit. A low-key batch sanitized-file export SHALL remain available with per-item and download-all behavior. A length-1 queue SHALL use the same status hook and shared publication wizard for exit ① while retaining its single-session exit ② and export presentation.

#### Scenario: Multi-session queue shows status-driven dual exits

- **WHEN** a queue with N>1 signed sessions reaches the exit step
- **THEN** the page shows the status-driven public GitHub contribution card and batch API direct-submit card as equals, with batch export as a secondary action

#### Scenario: Single and batch publication share readiness

- **WHEN** length-1 and N>1 queues read publication readiness
- **THEN** both consume the same five-state daemon status rather than distinct preflight flags or batch availability rules

#### Scenario: Non-ready status preserves other exits

- **WHEN** GitHub publication is unconfigured, login-required, blocked, loading, or unavailable
- **THEN** only exit ① is disabled while batch direct submit and gate-allowed sanitized-file export keep their existing behavior

#### Scenario: Batch export downloads each gated export

- **WHEN** the user invokes download-all on N signed sessions
- **THEN** each file comes from that review's gated export and a refused export shows an inline per-item error and downloads nothing for that item

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

### Requirement: Unified collection publication wizard

The batch exit-① SHALL pass all queue `reviewIds` to the same `PublishWizard`, publication preview route, error model, confirmation, submit route, and receipt presentation used by a one-review exit. It SHALL NOT maintain a batch-only plan, stage, submit, manual fallback, status derivation, or publication receipt type. Per-review errors SHALL retain review/session/rule attribution so the queue can return to the affected review through the existing affirmation-void guard.

#### Scenario: N greater than one uses one preview request

- **WHEN** a queue containing multiple cleared reviews opens exit ①
- **THEN** the shared wizard sends their IDs in one `{ reviewIds }` preview request and receives one branch, one digest, and one PR preview

#### Scenario: Single and batch use the same component

- **WHEN** one-review and multi-review exits are inspected
- **THEN** both instantiate the same `PublishWizard` and differ only in the `reviewIds` collection and presentation copy

#### Scenario: Batch preview enumerates safe file commitments

- **WHEN** a multi-review preview succeeds
- **THEN** the shared preview shows total records/bytes and every record/provenance path, kind, byte count, and hash without exact contents or a batch-specific response shape

#### Scenario: Batch pre-check refusal jumps to one review

- **WHEN** a preview or submit refusal names a review/session/rule in the queue
- **THEN** the user can return to that review and rule group through the existing queue switch and affirmation-void behavior

#### Scenario: Batch public fork effect is confirmed once

- **WHEN** one multi-review preview reports an on-submit fork
- **THEN** one final dialog names the upstream, predicted public fork, and aggregate record count before the exact sealed batch is submitted

#### Scenario: Batch retry remains one publication

- **WHEN** a retryable submit failure occurs for the multi-review preview
- **THEN** retry uses the same publication ref, target revision, and digest and cannot fan out into per-review branches or PRs

#### Scenario: Batch receipt completes the journey

- **WHEN** unified batch submit succeeds
- **THEN** the real one-PR receipt is shown and the journey becomes completed without synthesizing a batch compare URL or title-only receipt
