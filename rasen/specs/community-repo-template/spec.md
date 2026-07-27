# community-repo-template

## Purpose

Defines the `templates/community-data-repo` scaffold: the instantiable community dataset repository, its CI workflow (shared-ruleset scan, engine-version-parity check against the provenance sidecar, canary self-test), the HF sync stub, and the incident-response playbook.

## Requirements

### Requirement: Community data-repo scaffold

The change SHALL provide a community data-repo template scaffold under `templates/community-data-repo/`. It SHALL include a data-repo README, concrete data-license configuration, a `data/` layout matching deterministic publisher paths, and a root `.mosga-dataset.json` compatibility manifest. Documentation SHALL describe canonical GitHub target publication and SHALL NOT instruct a user to select a local clone, run generated manual commands, or take over a daemon workspace.

#### Scenario: Scaffold contains the required skeleton

- **WHEN** the template is inspected
- **THEN** it contains README/license material, the matching `data/` layout, and `.mosga-dataset.json` with concrete supported values

#### Scenario: Legacy manual guidance is absent

- **WHEN** template and backend-owned publication documentation are searched
- **THEN** they contain no `--data-repo`, local-clone staging, generated command, or manual compare-URL fallback guidance

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

### Requirement: Development template installs independently

Until the coordinated `@mosga` engine packages are available from the public registry, the template SHALL vendor exact versioned tarball snapshots for every internal transitive package required by the scanner and SHALL pin them in its own `package-lock.json`. The tarballs and lockfile SHALL be treated as one release unit so a clean copy outside the monorepo can run `npm ci` without workspace links or an ancestor `node_modules`.

#### Scenario: Clean generated repository installs

- **WHEN** only the template directory is copied to a clean location and `npm ci` is run
- **THEN** all coordinated `@mosga/*@0.1.0` engine packages install from the committed, integrity-locked tarballs

#### Scenario: Template CI tracks the vendored engine

- **WHEN** a vendored tarball or lockfile changes
- **THEN** the scan workflow runs and validates the manifest, compatibility tests, and canary gate with that exact engine release

#### Scenario: Vendored archives contain no private machine identity

- **WHEN** template compatibility checks inspect every coordinated tarball
- **THEN** they reject every bounded drive-rooted `X:\Users\` occurrence, every NUL-bearing entry, and known private workspace-root strings while allowing environment-variable examples such as `%USERPROFILE%`

### Requirement: Compatibility manifest is strictly validated

The template SHALL define and test a strict `.mosga-dataset.json` contract containing `kind`, supported `contractVersion`, non-empty unique `acceptedSchemaVersions`, and a concrete non-placeholder `license`. Template validation/CI SHALL fail when the file is missing, malformed, unsupported, internally duplicated, or contains placeholder values.

#### Scenario: Valid template manifest passes

- **WHEN** template checks read the committed compatibility manifest
- **THEN** its kind/contract/schema/license values pass the same compatibility rules expected by publication readiness

#### Scenario: Placeholder or unsupported manifest fails

- **WHEN** a fixture omits the manifest, changes its kind/version, empties or duplicates schema versions, or sets a placeholder license
- **THEN** template validation fails with no live GitHub operation
