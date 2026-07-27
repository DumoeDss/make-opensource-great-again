## MODIFIED Requirements

### Requirement: Prepare a PR contribution only after a passing pre-check

Given a sealed target-independent `ContributionBundle`, the publication backend SHALL prepare a managed contribution only after explicit submit confirmation and after current review gates, target/content bindings, bundle byte/hash/path invariants, and the final exact-byte pre-check all pass. Preparation SHALL use the sealed upstream base commit and write the sealed exact files into a daemon-owned workspace. The publisher SHALL remain pure and SHALL NOT prepare a clone, branch, file, commit, push, or pull request.

#### Scenario: Clean sealed contribution is prepared

- **WHEN** confirmed submit revalidates an unexpired seal and every final pre-write gate passes
- **THEN** the backend creates the managed branch/files/commit from the sealed base and exact bytes

#### Scenario: No preparation for a failed final gate

- **WHEN** target revision, review gate/content, bundle invariants, or final exact-byte pre-check fails
- **THEN** no journal, workspace, branch, file, commit, fork, push, or pull-request mutation occurs

## ADDED Requirements

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

## REMOVED Requirements

### Requirement: gh CLI when present, documented manual path otherwise

**Reason**: CLI availability, local clone staging, emitted shell commands, and manual compare-URL fallback expose implementation authority and cannot provide the sealed, target-bound, idempotent publication contract.

**Migration**: None. The production backend uses its semantic GitHub adapter and returns typed readiness/errors. Users retain sanitized-file-only export as the non-GitHub fallback; no legacy command wrapper or manual publication route remains.
