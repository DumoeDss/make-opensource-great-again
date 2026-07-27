## MODIFIED Requirements

### Requirement: Daemon batch publish routes with per-review attribution

The daemon SHALL expose one `POST /api/publish/preview` route accepting `{ reviewIds: string[] }` for both single and batch publication and one target-bound submit route consuming the resulting sealed publication. `reviewIds` SHALL contain 1–500 input entries and be deterministically deduplicated. Every review SHALL be checked individually: an unknown review yields `review_not_found` with its `reviewId`; a locked gate yields `GATE_LOCKED` with its `reviewId` and gate; a pre-check refusal yields `precheck_refused` with per-review/session rule-aggregated counts only. The daemon SHALL NOT retain separate per-review or `/batch/plan|stage|submit` publication routes.

#### Scenario: One review uses the collection route

- **WHEN** preview receives one review ID
- **THEN** it uses the same collection compiler, sealed preview, response type, and submit flow as a larger selection

#### Scenario: Locked review is named

- **WHEN** a multi-review preview contains a review whose gate is locked
- **THEN** the response is `GATE_LOCKED` carrying that review’s ID and no publication mutation occurs

#### Scenario: Aggregated pre-check refusal is safe

- **WHEN** exact bytes for multiple selected reviews are refused
- **THEN** the response attributes each refusal by review/session and rule counts without raw matched values or record contents

#### Scenario: Legacy batch routes are absent

- **WHEN** a client calls `/api/publish/batch/plan`, `/stage`, `/submit`, or a per-review publish plan/stage/submit route
- **THEN** the daemon returns route-not-found and does not invoke publication

### Requirement: Batch routes share the single-flight mutex and UI-safe plan discipline

Preview SHALL be read-only and SHALL return only the UI-safe publication target, PR metadata, engine identity, totals, and per-file path/byte/hash summaries. All N=1/N>1 submits SHALL share the same publication single-flight lock and durable journal/receipt discipline; a concurrent submit SHALL return `publish_in_flight`. Exact record/provenance contents, local paths, commands, and raw external output SHALL never be returned.

#### Scenario: Unified preview returns no exact bytes

- **WHEN** a multi-review preview succeeds
- **THEN** it returns record count, totals, digest, PR/target facts, and file commitments with no file contents

#### Scenario: Single and batch submits exclude each other

- **WHEN** any confirmed publication submit is in flight and another N=1 or N>1 submit arrives
- **THEN** the second returns `publish_in_flight`

#### Scenario: Dead-owner recovery cannot remove a replacement holder

- **WHEN** two processes observe the same dead acquisition claim, one process recovers it and acquires a new live claim, and the other stale observer resumes
- **THEN** the stale observer cannot remove the new claim, a third submit remains blocked, and a fresh process can recover only after the live owner exits
