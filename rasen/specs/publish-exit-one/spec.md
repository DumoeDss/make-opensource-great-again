# publish-exit-one Specification

## Purpose
TBD - created by archiving change mosga-v03-publish-exit-one. Update Purpose after archive.
## Requirements
### Requirement: Typed publish error taxonomy

Publication UI calls SHALL consume the daemon's stable `{ code, phase, message, retryable, recovery? }` error shape, plus safe optional review/gate/refusal attribution. `preview_not_found`, `preview_expired`, `preview_stale`, and `target_changed` SHALL discard the current preview and require a new preview before confirmation. `review_not_found` and `GATE_LOCKED` SHALL return the journey to the attributed review. `precheck_refused` SHALL render only review/session/rule counts. A retryable delivery error SHALL retain and retry the exact same ref/revision/digest binding. Malformed or transport errors SHALL use generic local copy rather than displaying arbitrary response or exception text.

#### Scenario: Expired preview requires re-preview

- **WHEN** submit returns `preview_expired` or `preview_not_found`
- **THEN** the wizard clears the old preview, refreshes status, returns to the preview step, and prevents submit until a new preview succeeds

#### Scenario: Stale target or content requires a new confirmation

- **WHEN** submit returns `preview_stale` or `target_changed`
- **THEN** the wizard discards the sealed summary and requires a new preview and public confirmation rather than resubmitting the old binding

#### Scenario: Gate attribution returns to review

- **WHEN** the daemon returns `review_not_found` or `GATE_LOCKED` with a `reviewId`
- **THEN** the UI offers or performs a jump to that review's disposition workspace and sends no publication mutation

#### Scenario: Pre-check refusal is count-only

- **WHEN** preview or submit returns `precheck_refused`
- **THEN** the UI groups `blockingByRule` counts by review/session and offers attributed review/rule jumps without rendering a raw match, exact record, or external error text

#### Scenario: Retryable submit preserves identity

- **WHEN** a retryable delivery failure such as `publish_in_flight`, `github_unavailable`, `fork_failed`, `workspace_unavailable`, `push_rejected`, or `pr_create_failed` occurs
- **THEN** retry sends the exact same publication ref, revision, and digest and does not create a replacement preview or client-side publication identity

#### Scenario: Unknown failure is generic

- **WHEN** an HTTP/network failure does not contain a valid typed publication error
- **THEN** the UI shows generic safe recovery copy and never stringifies the raw response, exception, command, path, token, stdout, or stderr into the page

### Requirement: Step-④ publish wizard

The exit-① flow SHALL use one three-part `PublishWizard` for any `reviewIds` selection: **安全预览** calls `POST /api/publish/preview`; **PR 预览** presents the sealed UI-safe target and contribution summary; **确认并创建 PR** obtains a dedicated public-publication confirmation and calls `POST /api/publish/submit`. The wizard SHALL show upstream, push repository, direct/fork route, fork provision/creation effect, base branch/commit, contribution branch, PR title/body, record/file totals, repository-relative file path/byte/hash commitments, content digest, engine identity, and expiry. It SHALL render the real receipt on success and SHALL NOT expose a separate stage or manual fallback.

#### Scenario: One review uses the collection preview

- **WHEN** a single-session exit opens the wizard
- **THEN** it calls `/api/publish/preview` with `{ reviewIds: [reviewId] }` and uses the same preview component and submit contract as a multi-review selection

#### Scenario: Preview identifies direct delivery

- **WHEN** preview returns route `direct`
- **THEN** the wizard clearly shows the canonical upstream as both the PR target and push repository together with the sealed base branch/commit

#### Scenario: Preview identifies existing fork delivery

- **WHEN** preview returns route `fork` with `forkProvision: "existing"`
- **THEN** the wizard separately names the upstream PR target and existing fork push repository and states that no new fork will be created

#### Scenario: Preview identifies public fork creation

- **WHEN** preview returns `willCreateFork: true` with `forkProvision: "on-submit"`
- **THEN** the wizard states in both preview and final confirmation that confirmed submit may create the named public fork before opening the upstream PR

#### Scenario: Final confirmation is separate from donation affirmation

- **WHEN** the queue donation affirmation has already allowed the user to enter exit ① and a valid preview is ready
- **THEN** the wizard still requires a dedicated confirmation naming the public PR target and fork effect, and cancelling it performs no submit

#### Scenario: Confirmation sends sealed bindings

- **WHEN** the user accepts the public-publication confirmation
- **THEN** the wizard sends the preview's exact `publicationRef`, target revision, content digest, and `confirmPublic: true`, with no other field

#### Scenario: Preview expiry blocks confirmation

- **WHEN** the displayed `expiresAt` passes before confirmation
- **THEN** the UI marks the preview expired, disables submit, and requires a fresh preview while retaining the daemon as the authoritative expiry check

#### Scenario: Successful submit renders a real receipt

- **WHEN** confirmed submit succeeds
- **THEN** the wizard displays the real PR URL/number, upstream, push repository, direct/fork mode, base branch/commit, contribution branch/commit, target revision, record count, digest, and submitted time and marks the journey completed

#### Scenario: PR link is safe and usable

- **WHEN** a receipt is displayed
- **THEN** its `prUrl` is an accessible link opened with safe new-tab behavior and no compare URL or fabricated PR identity is shown

#### Scenario: Layout and interaction remain accessible

- **WHEN** the wizard is used at narrow or desktop width with pointer or keyboard input
- **THEN** target facts and file commitments remain readable, long slugs/hashes wrap or scroll without clipping, progress/errors are announced, focus is visible, and the confirmation dialog is keyboard-operable

### Requirement: Publication status drives the exit-one card

The exit-① card SHALL consume the daemon's `GET /api/publish` discriminated status directly and SHALL NOT derive readiness from Git, `gh`, local-repository, or worktree booleans. It SHALL render only `unconfigured`, `login_required`, `fork_confirmation_required`, `ready`, or `blocked` as domain status, with loading/transport failure represented separately as UI request state. Publication SHALL be enabled only for `ready` and `fork_confirmation_required`.

#### Scenario: Unconfigured target disables publication

- **WHEN** status is `unconfigured`
- **THEN** the card identifies that a GitHub `owner/repo` target must be configured in Settings and disables the publication action

#### Scenario: Login-required target is named safely

- **WHEN** status is `login_required` with a safe target summary
- **THEN** the card shows the canonical upstream/default branch and curated login guidance without showing a token, credential-store detail, command output, or local path, and keeps publication disabled

#### Scenario: Fork confirmation can enter preview

- **WHEN** status is `fork_confirmation_required`
- **THEN** the card names the actor, canonical upstream, and predicted push repository, explains that a public fork may be created only after confirmation, and enables the read-only preview action

#### Scenario: Ready route is explicit

- **WHEN** status is `ready`
- **THEN** the card shows the actor, canonical upstream, default branch/base, direct-or-fork route, actual push repository, target revision, and readiness while enabling publication

#### Scenario: Blocked status does not invent target facts

- **WHEN** status is `blocked`
- **THEN** the card shows only supplied target facts and curated issues, keeps publication disabled, and does not reuse a client draft or previously loaded target as server authority

#### Scenario: Transport failure is not a sixth domain status

- **WHEN** the publication status request fails before a typed daemon status is received
- **THEN** the card presents a retryable UI load error and does not label the domain as ready, blocked, or unconfigured

### Requirement: Publication UI exposes no local delivery authority

The UI SHALL send and render only the committed publication HTTP contract. It SHALL NOT accept or display a workspace or data-repository path, clone/push/remote URL, remote name, branch override, fork selector, token, Git/`gh` command, raw stdout/stderr, exact contribution file contents, or uncurated error payload. Target configuration SHALL send only `{ repository }`; preview SHALL send only `{ reviewIds }`; submit SHALL send only the sealed `publicationRef`, `targetRevision`, `contentDigest`, and literal `confirmPublic: true`.

#### Scenario: Target request carries only repository

- **WHEN** the user saves `owner/repo`
- **THEN** the client sends `PUT /api/publish/target` with JSON `{ repository: "owner/repo" }` and no path, URL, host, credential, remote, branch, or workspace field

#### Scenario: Preview omits sealed contents

- **WHEN** a publication preview is rendered
- **THEN** it may show repository-relative paths, bytes, and hashes but never `files[].contents`, a daemon workspace, command, raw output, or arbitrary raw preview JSON

#### Scenario: Submit body is exact

- **WHEN** the user confirms public publication
- **THEN** the client submits exactly the ref, target revision, content digest, and `confirmPublic: true` copied from the displayed preview and accepts no user-edited delivery authority

#### Scenario: Legacy disclosure scan is clean

- **WHEN** live UI source and tests are searched after the replacement
- **THEN** they contain no `--data-repo`, `dataRepoPath`, `dataRepoConfigured`, local-clone/manual-command fallback, old plan/stage/batch route, emitted command list, or rendered workspace path
