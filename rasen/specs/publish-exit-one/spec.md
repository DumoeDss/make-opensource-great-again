# publish-exit-one Specification

## Purpose
TBD - created by archiving change mosga-v03-publish-exit-one. Update Purpose after archive.
## Requirements
### Requirement: Publish plan route returns a UI-safe plan

The daemon SHALL expose `POST /api/reviews/:reviewId/publish/plan` that runs the sanitized export and the MANDATORY pre-check and computes a contribution plan in memory (no disk write, no git mutation). When the review gate is locked it SHALL return HTTP 409 (mirroring `/export`). On success it SHALL return the UI-safe subset of the plan — `branch`, `targetBranch`, `recordPath`, `provenancePath`, `prTitle`, `prBody`, `commitMessage`, `recordCount`, `ghAvailable`, `stagedFiles`, `commands`, `provenance`, `engine` — plus a daemon-derived `compareUrl` and a record summary (`recordBytes` byte length + `contentHash`), and SHALL EXCLUDE the serialized record bytes. `compareUrl` SHALL be derived from the clone's `origin` remote (`git remote get-url origin`) as a GitHub compare URL, or `null` when the remote is absent or not GitHub.

#### Scenario: Plan refused while the gate is locked

- **WHEN** a plan is requested for a review whose gate is locked
- **THEN** the daemon returns 409 with the gate and computes no plan

#### Scenario: Plan returns the UI-safe subset without record bytes

- **WHEN** a plan is requested for an unlocked review with a configured data repo
- **THEN** the response contains the enumerated plan fields plus `compareUrl` and the record summary, and does NOT contain the serialized record bytes

#### Scenario: Compare URL derived from the origin remote

- **WHEN** the data-repo clone has a GitHub `origin` remote
- **THEN** `compareUrl` is a GitHub compare URL for `targetBranch...branch`; when origin is absent or non-GitHub it is `null`

### Requirement: Publish stage and submit routes with a stage state model

The daemon SHALL expose `POST /api/reviews/:reviewId/publish/stage` (write the record + provenance sidecar + PR-body file, create the branch, `git add`, `git commit`) and `POST /api/reviews/:reviewId/publish/submit` (push + open the PR via `gh`). Both SHALL return 409 while the gate is locked. The daemon SHALL hold a per-review in-memory stage state (`staged` flag + branch name); `submit` SHALL stage first only when the flag is unset. Only one publish (stage or submit) SHALL be in flight at a time; a concurrent request SHALL be rejected with a `publish_in_flight` code.

#### Scenario: Stage records the staged flag and branch

- **WHEN** a stage succeeds for a review
- **THEN** the record/provenance/PR-body files are written, the branch is created and committed, and the daemon marks the review staged with its branch name

#### Scenario: Submit stages first only when not already staged

- **WHEN** submit is called for a review that has already staged
- **THEN** the daemon does not re-stage and proceeds to push + open the PR; when it has not staged, submit stages first

#### Scenario: Concurrent publish is rejected

- **WHEN** a stage or submit is requested while another publish is in flight
- **THEN** the daemon rejects it with a `publish_in_flight` code and does not start a second git mutation

### Requirement: Typed publish error taxonomy

Publish routes SHALL classify failures with typed `code`s and actionable guidance, to the standard of the existing `/submit` endpoint: `precheck_refused` (the pre-check found surviving blocking findings — details rule-aggregated as `{ ruleId, count }`, never raw values), `repo_dirty` (the working tree is not clean), `branch_exists` (the deterministic branch already exists on a fresh stage — the response includes the existing branch name and delete-or-continue guidance, with NO auto-cleanup), `gh_unauthenticated` (`gh` present but `gh auth status` fails), and `push_rejected` (the remote rejected the push). Configuration/availability failures SHALL use `data_repo_unconfigured`, `git_unavailable`, and `publish_in_flight`.

#### Scenario: Pre-check refusal is rule-aggregated

- **WHEN** the plan/stage pre-check finds surviving blocking findings
- **THEN** the response has code `precheck_refused` with per-rule counts and no raw finding values

#### Scenario: Stale deterministic branch guides, does not auto-clean

- **WHEN** a fresh stage finds the deterministic branch already exists
- **THEN** the response has code `branch_exists`, names the existing branch, and gives delete-or-continue guidance without deleting the branch

#### Scenario: gh present but unauthenticated is distinguished

- **WHEN** `gh` is installed but `gh auth status` reports not-logged-in at submit
- **THEN** the response has code `gh_unauthenticated` with guidance, distinct from `gh` being absent

### Requirement: Publish preflight route

The daemon SHALL expose `GET /api/publish/preflight` returning `{ dataRepoConfigured, gitAvailable, ghAvailable, ghAuthenticated, repoClean }`: `gitAvailable`/`ghAvailable` from a `--version` probe, `ghAuthenticated` from `gh auth status`, `repoClean` from a clean `git status --porcelain` in the configured clone, and `dataRepoConfigured` from the presence of a configured, existing data-repo path. These SHALL drive the exit-① card's four states.

#### Scenario: Preflight reports the five capability flags

- **WHEN** preflight is requested
- **THEN** it returns the five booleans reflecting the data-repo config, git/gh availability, gh authentication, and repo cleanliness

#### Scenario: Card state derives from preflight

- **WHEN** `dataRepoConfigured` is false
- **THEN** the exit-① card shows the 需配置 state; when git is missing or the repo is dirty it shows 缺依赖; when gh is present but unauthenticated it shows gh 未登录; otherwise 就绪

### Requirement: Data-repo path is trusted server-side config

The data-repo path SHALL be a daemon option set at startup only (a `--data-repo <path>` flag / server config), following the exact trust model of the provider key config path: it SHALL NEVER be writable via any HTTP route. The settings page SHALL show a read-only configured / not-configured status plus guidance to restart with `--data-repo <path>`; the literal filesystem path SHALL NOT be echoed over the HTTP surface.

#### Scenario: Data-repo path is never accepted from a request

- **WHEN** any HTTP request attempts to set or change the data-repo path
- **THEN** the daemon ignores it; the path comes only from startup config

#### Scenario: Settings shows configured status read-only

- **WHEN** the settings page loads
- **THEN** it shows whether the data repo is configured and the restart guidance, with no edit control and without printing the raw path

### Requirement: Step-④ publish wizard

The exit-① card SHALL present a three-step publish wizard: **预检** (call `publish/plan`; show pending and timeout states; on `precheck_refused` show the rule-aggregated blocked reasons with a jump back to the step-② group for that rule) → **PR 预览** (`prTitle`/`prBody` rendered as a styled preformatted block, the staged file list, the branch, and `compareUrl`) → **提交** (call `publish/stage`, always writing to disk; when `ghAvailable && ghAuthenticated`, offer a one-click `publish/submit`; otherwise show the staged file locations, the exact `plan.commands` — noting the last is `gh pr create` — the `git push` + `compareUrl` browser fallback, and per-command copy buttons). A successful submit SHALL feed the journey's step-④ completion state.

#### Scenario: Pre-check refusal routes back to the finding

- **WHEN** the 预检 step returns `precheck_refused`
- **THEN** the wizard shows the rule-aggregated reasons and offers a jump back to step ② for the named rule group

#### Scenario: gh-free path shows commands and the compare fallback

- **WHEN** the 提交 step runs and `gh` is absent or unauthenticated
- **THEN** the wizard stages to disk and shows the staged file locations, the copyable command sequence, and the `git push` + `compareUrl` fallback

#### Scenario: One-click submit completes the journey

- **WHEN** `gh` is available and authenticated and the user submits
- **THEN** the PR is pushed and opened and the journey shows the 已完成 completion state

