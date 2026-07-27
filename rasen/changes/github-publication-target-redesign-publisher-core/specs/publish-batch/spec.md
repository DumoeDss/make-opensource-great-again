## MODIFIED Requirements

### Requirement: Batch contribution plan with aggregated mandatory pre-check

The publisher SHALL compile N stamped sessions through the same pure `compileContributionBundle` operation used for one session. It SHALL export every record and run the MANDATORY pre-check on EVERY record's exact final file bytes with no fail-fast. A refusal SHALL aggregate every refused session into a typed error carrying deterministic rule-count summaries only. On a clean pass the compiler SHALL return one bundle with N records, N record/provenance file pairs, one content-bound branch, one commit message, and one PR title/body containing canonical per-session summaries plus the engine/provenance and attestation contract. All sessions MUST share the same exact `contributorAlias`; a mismatch SHALL be refused as a configuration error.

#### Scenario: Refusals aggregate across sessions

- **WHEN** a collection of three sessions is compiled and two still carry surviving blocking findings
- **THEN** the compiler throws one bundle refusal naming both refused sessions with rule-aggregated counts, and no partial bundle or side effect is produced

#### Scenario: Clean collection returns one canonical bundle

- **WHEN** every session passes the exact-byte pre-check
- **THEN** the result carries N canonical record summaries and file pairs, `recordCount = N`, one branch, one commit message, and a PR body with one summary row per session

#### Scenario: Alias mismatch is refused

- **WHEN** the collection contains sessions with differing exact `contributorAlias` values
- **THEN** compilation is refused as a configuration error rather than silently selecting one alias

### Requirement: Deterministic batch branch naming

A contribution of one session SHALL use `contrib/<alias>/<sessionId>-<digest8>`, and a contribution of more than one SHALL use `contrib/<alias>/batch-<digest8>`, where `digest8` is derived from the canonical full-bundle content digest. Canonical session/file ordering SHALL make the entire bundle, not only its branch, identical for the same logical session set in any input order. Any changed final file byte or path SHALL change the digest and branch suffix.

#### Scenario: Same selection maps to the same complete bundle

- **WHEN** the same set of sessions is compiled twice in any order with the same explicit options
- **THEN** both results deep-equal and name the identical content-bound branch

#### Scenario: Single-item collection uses unified semantics

- **WHEN** exactly one session is compiled
- **THEN** it has the same bundle shape, safety checks, file commitments, and downstream interface as a multi-session contribution

#### Scenario: Same IDs with changed bytes do not reuse a branch

- **WHEN** a selected session set keeps the same IDs but any final published file content changes
- **THEN** the aggregate digest and branch suffix change

## REMOVED Requirements

### Requirement: Batch stage and submit as one commit and one PR

**Reason**: The publisher is now a pure contribution-bundle compiler. Filesystem writes, Git commits, pushes, and pull-request creation belong to the target-aware publication backend and cannot depend on a caller-selected clone or publisher-owned `gh` sequence.

**Migration**: Consume `ContributionBundle` from the publication backend; write and hash-verify its exact files in a daemon-managed workspace, then perform one explicit target-aware commit/push/PR flow.
