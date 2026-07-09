# publish-batch Specification

## Purpose
TBD - created by archiving change mosga-v04-batch-publish-core. Update Purpose after archive.
## Requirements
### Requirement: Batch contribution plan with aggregated mandatory pre-check

The publisher SHALL provide an async batch plan that exports N stamped sessions and runs the MANDATORY pre-check on EVERY record's exact bytes, aggregating refusals across all sessions (no fail-fast) into a typed error carrying per-session blocking findings. On a clean pass it SHALL return one plan holding all N records, ONE branch, one commit message, and one batch PR title/body containing a per-session summary table plus the shared engine/provenance stamp. All sessions in a batch MUST share the same `contributorAlias`; a mismatch SHALL be refused as a configuration error, never silently resolved.

#### Scenario: Refusals aggregate across sessions

- **WHEN** a batch of 3 sessions is planned and 2 of them still carry surviving blocking findings
- **THEN** the plan throws a batch refusal naming BOTH refused sessions with their blocking findings, and nothing is planned, written, or staged

#### Scenario: Clean batch plans one branch with N records

- **WHEN** every session in the batch passes the pre-check
- **THEN** the plan carries N records (recordCount = N), one branch, one commit message, and a PR body whose summary table has one row per session

#### Scenario: Alias mismatch is refused

- **WHEN** the batch contains sessions with differing `contributorAlias` values
- **THEN** the plan is refused as a configuration error naming the conflict

### Requirement: Deterministic batch branch naming

A batch of one session SHALL degrade to the existing single-session plan semantics (same deterministic branch, title, and body). A batch of more than one SHALL use `contrib/<alias>/batch-<hash8>` where `hash8` is derived from the sha256 of the sorted sessionId list, so the same selection always maps to the same branch and a retry surfaces the existing stale-branch residue semantics.

#### Scenario: Same selection maps to the same branch

- **WHEN** the same set of sessions is planned twice (any order)
- **THEN** both plans name the identical `contrib/<alias>/batch-<hash8>` branch

#### Scenario: Single-item batch degrades to the single-session plan

- **WHEN** a batch of exactly one session is planned
- **THEN** the branch, title, and body equal the single-session contribution plan's

### Requirement: Batch stage and submit as one commit and one PR

Batch staging SHALL write all N records + provenance sidecars + the PR body file into the clone, create the batch branch once, and commit ALL staged files in ONE commit. Batch submit SHALL push the branch once and open ONE PR via `gh`. Both SHALL run through the async command runner only (no sync batch variants); a rejected push SHALL be distinguishable from a failed PR open.

#### Scenario: Stage writes N record pairs under one commit

- **WHEN** a clean batch plan of N sessions is staged
- **THEN** N records and N sidecars are written, and exactly one `git checkout -b` + `git add` + `git commit` sequence runs

#### Scenario: Submit pushes once and opens one PR

- **WHEN** a staged batch is submitted with `gh` authenticated
- **THEN** exactly one `git push` and one `gh pr create` run, and a rejected push is reported distinctly from a failed PR open

### Requirement: Daemon batch publish routes with per-review attribution

The daemon SHALL expose `POST /api/publish/batch/plan|stage|submit` accepting `{ reviewIds: string[] }` (validated: 1–500 items, deduplicated — 500 aligns with the daemon review capacity). Every review SHALL be checked individually and failures SHALL name the offending review: an unknown review yields 404 with its `reviewId`; a locked gate yields 409 `GATE_LOCKED` with the `reviewId` and gate. A pre-check refusal SHALL yield 422 `precheck_refused` with `blockingBySession` entries of `{ reviewId, sessionId, blockingByRule }` — rule-aggregated counts only, never raw matched values. All other error codes SHALL reuse the existing publish taxonomy unchanged.

#### Scenario: Locked review is named in the batch refusal

- **WHEN** a batch stage names three reviews and one gate is locked
- **THEN** the response is 409 `GATE_LOCKED` carrying that review's `reviewId`, and no git mutation ran

#### Scenario: Batch pre-check refusal is aggregated per session

- **WHEN** the batch plan's pre-check refuses two sessions
- **THEN** the 422 body's `blockingBySession` names both, each with rule-aggregated counts only

#### Scenario: Oversized or empty batches are rejected

- **WHEN** a batch request names zero or more than 500 reviewIds
- **THEN** the request is rejected as invalid before any review or git work runs

### Requirement: Batch routes share the single-flight mutex and UI-safe plan discipline

The batch routes SHALL share the SAME in-flight mutex as the per-review publish routes (a concurrent publish of either kind is rejected with `publish_in_flight`), and batch stage state SHALL be keyed by the sorted deduplicated reviewIds. The batch plan response SHALL be the UI-safe subset only: per-record `{ sessionId, recordPath, provenancePath, recordBytes, contentHash, messages }`, totals, and the derived `compareUrl` — record bytes are never returned.

#### Scenario: Batch and single publishes exclude each other

- **WHEN** a batch stage is in flight and a per-review stage (or another batch) arrives
- **THEN** the second request is rejected with `publish_in_flight`

#### Scenario: Batch plan returns no record bytes

- **WHEN** a batch plan succeeds
- **THEN** the response enumerates per-record metadata (path, byte count, content hash, message count) and the compare URL, with no record content field

