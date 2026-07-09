## MODIFIED Requirements

### Requirement: gh CLI when present, documented manual path otherwise

When the `gh` CLI is detected and authenticated, the publisher MAY push the branch and open the PR. When `gh` is absent, it SHALL instead emit the exact `git`/`gh` command sequence and the staged file list and document the manual steps. The publisher SHALL provide both a synchronous command runner (retained for the CLI and tests) and an asynchronous command-runner variant (for non-blocking use by the daemon, so git/gh subprocesses never block its event loop); both SHALL run the same commands with the same gh-present/gh-absent behaviour — the interface is widened, the behaviour is unchanged. A `gh`-authentication probe (`gh auth status`) SHALL distinguish `gh` present-but-unauthenticated from `gh` absent. Tests SHALL NOT push to or open a PR against a real external repo.

#### Scenario: gh-absent path emits exact commands

- **WHEN** the `gh` CLI is not available
- **THEN** the publisher outputs the exact `git`/`gh` commands and staged files for the contributor to run manually

#### Scenario: No live external PR in tests

- **WHEN** the PR-submission flow is exercised in tests
- **THEN** it runs against a local/dry-run target and never opens a PR on a real external repository

#### Scenario: Async runner mirrors the sync runner

- **WHEN** the staging/submission flow is run through the asynchronous command runner
- **THEN** it performs the same git/gh commands with the same gh-present/gh-absent outcome as the synchronous runner, without blocking the caller's event loop

#### Scenario: gh authentication is probed distinctly

- **WHEN** `gh` is installed but not logged in
- **THEN** the authentication probe reports unauthenticated, distinct from `gh` being absent
