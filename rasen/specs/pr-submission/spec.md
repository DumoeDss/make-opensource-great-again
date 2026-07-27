# pr-submission

## Purpose

Defines target-independent contribution-bundle compilation and the publication backend's sealed pull-request delivery: compiling exact PR metadata and files only after a passing pre-check, rendering a provenance-carrying PR body, and opening an explicit upstream pull request through the semantic GitHub adapter — never opening a live PR in tests.

## Requirements

### Requirement: Prepare a PR contribution only after a passing pre-check

Given a sealed target-independent `ContributionBundle`, the publication backend SHALL prepare a managed contribution only after explicit submit confirmation and after current review gates, target/content bindings, bundle byte/hash/path invariants, and the final exact-byte pre-check all pass. Preparation SHALL use the sealed upstream base commit and write the sealed exact files into a daemon-owned workspace. The publisher SHALL remain pure and SHALL NOT prepare a clone, branch, file, commit, push, or pull request.

#### Scenario: Clean sealed contribution is prepared

- **WHEN** confirmed submit revalidates an unexpired seal and every final pre-write gate passes
- **THEN** the backend creates the managed branch/files/commit from the sealed base and exact bytes

#### Scenario: No preparation for a failed final gate

- **WHEN** target revision, review gate/content, bundle invariants, or final exact-byte pre-check fails
- **THEN** no journal, workspace, branch, file, commit, fork, push, or pull-request mutation occurs

### Requirement: PR body from a template carrying the provenance stamp

The publisher SHALL render target-independent PR title/body metadata from one shared deterministic template pipeline for N=1 and N>1. The body SHALL include record/session count, canonical per-session summaries, provenance/pre-check engine information (`sanitizationRulesetVersion` where applicable, `sanitizerPackageVersion`, `rulesetVersion`, and `gitleaksVersion`), and the sanitization attestation and contributor-consent text. Rendering SHALL NOT read the wall clock or target/workspace/GitHub state.

#### Scenario: PR body includes the version stamp

- **WHEN** a contribution bundle is compiled
- **THEN** its PR body contains the ruleset version, sanitizer package version, gitleaks pin, record count, and sanitization attestation

#### Scenario: Recompilation preserves PR metadata

- **WHEN** the same logical sessions and explicit compiler options are compiled again in any input order
- **THEN** the PR title and body are byte-for-byte identical

### Requirement: Pull request delivery names upstream base and push head explicitly

The publication backend SHALL push the contribution branch to the resolved push repository and SHALL find/create the pull request against the canonical upstream with explicit upstream repository, base branch, push repository, and head branch identity. Lookup SHALL verify the upstream repository ID/full name, base ref, head repository full name, and head ref semantically. Creation SHALL use a bare branch head for a direct route and `<authenticated-user>:<branch>` only for a verified fork route. It SHALL NOT derive any of those values from cwd, `origin`, or caller input.

#### Scenario: Fork push opens an upstream pull request

- **WHEN** the selected route uses the authenticated actor’s verified fork
- **THEN** the branch is pushed to that fork and the PR is explicitly opened against the sealed upstream/default-branch base

#### Scenario: Direct push opens an upstream pull request

- **WHEN** the actor can push to upstream
- **THEN** push and PR target the upstream explicitly while retaining separate internal upstream/push semantics

### Requirement: Pull request submission returns a real idempotent receipt

Successful submission SHALL return and persist an immutable receipt containing the real PR number/URL, commit SHA, upstream, push repository, mode, base, branch, record count, target revision, content digest, and submitted time. Retry/recovery SHALL find the exact existing upstream/base/head PR before any create call and SHALL return the same receipt rather than duplicate a PR.

#### Scenario: Existing exact pull request is adopted

- **WHEN** the branch was pushed and an exact upstream/base/head PR already exists
- **THEN** submission adopts that PR and persists/returns its real identity

#### Scenario: Retry returns the original receipt

- **WHEN** the same sealed submission is retried after completion
- **THEN** the backend returns the original receipt without a new push or PR
