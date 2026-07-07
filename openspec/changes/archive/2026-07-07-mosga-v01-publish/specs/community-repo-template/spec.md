## ADDED Requirements

### Requirement: Community data-repo scaffold

The change SHALL provide a community data-repo template scaffold (under `templates/`) that the initiator can instantiate as the real community repository. It SHALL include a data-repo `README` (contribution guide), a data-`LICENSE` placeholder (Open Question 2, e.g. CC-BY / ODC-BY 待定), and the `data/` layout matching the exporter's deterministic placement.

#### Scenario: Scaffold contains the required skeleton

- **WHEN** the template is inspected
- **THEN** it contains a README, a data-LICENSE placeholder, and a `data/` layout consistent with the export path scheme

### Requirement: CI workflow runs the shared ruleset on every PR

The template SHALL include a CI workflow that, on every incoming PR, installs the pinned `@mosga/sanitizer` version and re-runs the shared-ruleset scan over each changed record file, failing the check on any blocking finding. This is the verification defense mirroring the local pre-check with the identical pinned engine.

#### Scenario: CI scans changed records with the pinned engine

- **WHEN** a PR adds or changes a record file
- **THEN** the CI workflow installs the pinned `@mosga/sanitizer` and scans the changed record(s), failing on any blocking finding

### Requirement: CI verifies engine version parity against the provenance sidecar

The CI scan SHALL read each record's committed `*.provenance.json` sidecar and compare its `sanitizerPackageVersion`, `sanitizationRulesetVersion`, and `gitleaksVersion` to the engine CI actually scanned with, FAILING the check on any mismatch. A local/CI engine divergence SHALL therefore be a visible failure, not a silent gap (realizing the m3 "visible failure on mismatch" guarantee). Reading the sidecar also brings it inside the scan/verification boundary.

#### Scenario: A record stamped by a non-matching engine fails CI

- **WHEN** a record's provenance sidecar records a `sanitizerPackageVersion`/`rulesetVersion` different from the CI-pinned engine
- **THEN** the CI scan reports the mismatch and fails the check

### Requirement: Canary fixtures prove the gate is alive

The template SHALL include obviously-fake canary records with planted fake secrets, and the CI SHALL assert those canaries ARE caught (a scan that passed them would mean the gate is broken). All canary secrets SHALL be non-functional fakes. The canary set SHALL include at least one record whose secret is planted OUTSIDE the message body (e.g. in `meta.toolVersion` / `session.projectKey`), so the self-test also exercises the raw-bytes backstop coverage.

#### Scenario: CI fails if a canary is not caught

- **WHEN** the CI runs against the canary fixtures
- **THEN** it asserts the planted fake secrets are detected, and treats a miss as a build failure (the gate self-test)

#### Scenario: A canary with a secret outside message content is still caught

- **WHEN** the CI runs against the canary whose secret sits in `meta`/`projectKey` (not message content)
- **THEN** it is still detected (proving the raw-bytes backstop, not only the structured scan, is alive)

### Requirement: HuggingFace sync stub

The template SHALL include a documented HuggingFace sync script stub that describes batch-syncing merged records to a HF dataset. Actual upload and credentials are out of scope and SHALL be clearly marked as operator steps; the stub SHALL NOT perform a live upload.

#### Scenario: HF sync is a documented stub

- **WHEN** the HF sync script is inspected
- **THEN** it documents the sync flow and is clearly marked a stub with creds/upload out of scope, performing no live upload

### Requirement: INCIDENT-RESPONSE.md leak playbook

The change SHALL provide an `INCIDENT-RESPONSE.md` covering the post-publication leak response: (1) remove the record from the HF dataset and re-release; (2) rewrite the data-repo git history (or rotate/replace the repo) to purge the secret; (3) notify the affected contributor to revoke/rotate the leaked credential; (4) publish a public incident record; and (5) a prevention follow-up adding a rule for the missed pattern to the shared ruleset. It SHALL name owners/roles and expected timeline.

#### Scenario: Playbook covers the required steps

- **WHEN** INCIDENT-RESPONSE.md is inspected
- **THEN** it covers HF removal + re-release, history rewrite/rotation, contributor credential-rotation notice, a public incident record, and a prevention follow-up, with named owners and timeline
