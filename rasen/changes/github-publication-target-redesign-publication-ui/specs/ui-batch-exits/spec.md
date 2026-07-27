## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Batch publish wizard over the batch routes

**Reason**: Separate batch plan/stage/submit routes, command fallback, and a second wizard duplicated the publication state machine and were removed by the unified `reviewIds` backend contract.

**Migration**: None. N>1 uses the same `PublishWizard`, preview route, strict submit body, and real receipt as N=1.
