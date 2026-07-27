## MODIFIED Requirements

### Requirement: Prepare a PR contribution only after a passing pre-check

Given one or more stamped sessions, the publisher SHALL compile target-independent PR metadata and exact contribution files in memory only after every final record file body passes the mandatory pre-check. The publisher SHALL NOT prepare a working clone, create or mutate a branch, write a file, create a commit, push, or create a pull request. Its output SHALL stop at a deterministic `ContributionBundle` for the target-aware publication backend.

#### Scenario: Clean contribution metadata is compiled

- **WHEN** all requested sessions pass the final-byte pre-check
- **THEN** the publisher returns exact files plus deterministic branch, commit-message, PR-title, and PR-body metadata without any filesystem or external mutation

#### Scenario: No preparation for a failed pre-check

- **WHEN** any requested record fails the mandatory pre-check
- **THEN** the publisher returns no partial bundle and performs no branch, file, commit, push, or pull-request operation

### Requirement: PR body from a template carrying the provenance stamp

The publisher SHALL render target-independent PR title/body metadata from one shared deterministic template pipeline for N=1 and N>1. The body SHALL include record/session count, canonical per-session summaries, provenance/pre-check engine information (`sanitizationRulesetVersion` where applicable, `sanitizerPackageVersion`, `rulesetVersion`, and `gitleaksVersion`), and the sanitization attestation and contributor-consent text. Rendering SHALL NOT read the wall clock or target/workspace/GitHub state.

#### Scenario: PR body includes the version stamp

- **WHEN** a contribution bundle is compiled
- **THEN** its PR body contains the ruleset version, sanitizer package version, gitleaks pin, record count, and sanitization attestation

#### Scenario: Recompilation preserves PR metadata

- **WHEN** the same logical sessions and explicit compiler options are compiled again in any input order
- **THEN** the PR title and body are byte-for-byte identical

## REMOVED Requirements

### Requirement: gh CLI when present, documented manual path otherwise

**Reason**: GitHub client availability, authentication, local clone staging, manual shell commands, pushes, and PR creation are delivery concerns owned by the new target-aware publication backend, not the pure publisher.

**Migration**: The publication backend consumes `ContributionBundle` through its semantic GitHub/workspace adapters and supplies explicit upstream/base/head values. There is no publisher compatibility wrapper or manual-command fallback.
