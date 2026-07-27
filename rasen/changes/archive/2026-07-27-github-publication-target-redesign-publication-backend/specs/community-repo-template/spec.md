## MODIFIED Requirements

### Requirement: Community data-repo scaffold

The change SHALL provide a community data-repo template scaffold under `templates/community-data-repo/`. It SHALL include a data-repo README, concrete data-license configuration, a `data/` layout matching deterministic publisher paths, and a root `.mosga-dataset.json` compatibility manifest. Documentation SHALL describe canonical GitHub target publication and SHALL NOT instruct a user to select a local clone, run generated manual commands, or take over a daemon workspace.

#### Scenario: Scaffold contains the required skeleton

- **WHEN** the template is inspected
- **THEN** it contains README/license material, the matching `data/` layout, and `.mosga-dataset.json` with concrete supported values

#### Scenario: Legacy manual guidance is absent

- **WHEN** template and backend-owned publication documentation are searched
- **THEN** they contain no `--data-repo`, local-clone staging, generated command, or manual compare-URL fallback guidance

## ADDED Requirements

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
