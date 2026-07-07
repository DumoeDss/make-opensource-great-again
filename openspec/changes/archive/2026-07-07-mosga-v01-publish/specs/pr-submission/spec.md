## ADDED Requirements

### Requirement: Prepare a PR contribution only after a passing pre-check

Given a target data-repo and a pre-check-passing artifact, the publisher SHALL prepare a contribution: a working clone, a new branch named deterministically (e.g. `contrib/<contributorAlias>/<sessionId>`), the record placed at its deterministic path, and a commit. Preparation SHALL NOT proceed for an artifact that failed the pre-check.

#### Scenario: Contribution is staged for a clean artifact

- **WHEN** a pre-check-passing artifact is submitted for a target repo
- **THEN** the publisher stages a branch, the placed record file, and a commit ready to push

#### Scenario: No preparation for a failed pre-check

- **WHEN** the artifact failed the pre-check
- **THEN** the publisher does not stage any branch, file, or commit

### Requirement: PR body from a template carrying the provenance stamp

The PR body SHALL be rendered from a template including the provenance stamp (`schemaVersion`, `sanitizationRulesetVersion`, `sanitizerPackageVersion`, `gitleaksVersion`), the record/session count, and a sanitization attestation. This lets a maintainer and the CI verify version parity at review time.

#### Scenario: PR body includes the version stamp

- **WHEN** the PR body is generated
- **THEN** it contains the ruleset version, the sanitizer package version, and the gitleaks pin used

### Requirement: gh CLI when present, documented manual path otherwise

When the `gh` CLI is detected and authenticated, the publisher MAY push the branch and open the PR. When `gh` is absent, it SHALL instead emit the exact `git`/`gh` command sequence and the staged file list and document the manual steps. Tests SHALL NOT push to or open a PR against a real external repo.

#### Scenario: gh-absent path emits exact commands

- **WHEN** the `gh` CLI is not available
- **THEN** the publisher outputs the exact `git`/`gh` commands and staged files for the contributor to run manually

#### Scenario: No live external PR in tests

- **WHEN** the PR-submission flow is exercised in tests
- **THEN** it runs against a local/dry-run target and never opens a PR on a real external repository
