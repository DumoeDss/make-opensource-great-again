# github-publication Specification

## Purpose

Defines the `@mosga/daemon` GitHub publication backend: one canonical `owner/repo` target, semantic readiness resolution, sealed preview and confirmed submit, managed workspace writes, explicit push and pull-request delivery, idempotent retry/recovery, and a safe HTTP contract — with no local-clone, credential, or manual-command surface.

## Requirements

### Requirement: One canonical GitHub publication target

The daemon SHALL store exactly one active publication target as a canonical github.com `owner/repo` plus a monotonic revision. It SHALL persist target changes atomically and server-side, preserve revision history across clear/reconfigure operations, and SHALL NOT accept or persist a local path, URL, arbitrary host, credential, remote name, branch, fork repository, or workspace setting. Configuring the identical target and clearing an already empty target SHALL be idempotent.

#### Scenario: Canonical target is configured atomically

- **WHEN** a client configures a valid canonical `owner/repo`
- **THEN** the daemon atomically persists that upstream with a new revision and returns HTTP-safe readiness for that revision

#### Scenario: Non-canonical target input is rejected

- **WHEN** a client submits a filesystem path, GitHub URL, SSH form, credential-bearing value, arbitrary host, branch, remote, or extra path segment
- **THEN** the daemon returns `invalid_target` and does not change the stored target or revision

#### Scenario: Clear invalidates prior previews

- **WHEN** a configured target is cleared
- **THEN** the daemon persists an unconfigured state at a newer revision and every unsubmitted preview for the old revision becomes unusable

#### Scenario: Concurrent daemon processes do not reuse a revision

- **WHEN** multiple daemon processes mutate one file-backed target while a dead owner's acquisition claim is being recovered
- **THEN** every successful semantic mutation consumes a distinct monotonic revision and no stale reclaimer can delete a newer live claim

### Requirement: Target readiness is resolved from semantic GitHub state

The daemon SHALL expose discriminated publication status for `unconfigured`, `login_required`, `fork_confirmation_required`, `ready`, and `blocked`. For a configured target it SHALL resolve the authenticated actor, stable upstream repository identity, public visibility, default branch and head commit, viewer permission, verified fork state, and target compatibility through read-only GitHub operations. Status SHALL contain only safe GitHub facts and stable issues, never a local workspace path, credential, command, or raw external output.

#### Scenario: Writable upstream is ready for direct publication

- **WHEN** the configured public compatible upstream is writable by the authenticated actor
- **THEN** status is `ready` with route `direct`, and both upstream and push repository identify that upstream

#### Scenario: Login is required

- **WHEN** a canonical target is stored but no authenticated GitHub actor can be resolved
- **THEN** status is `login_required` without exposing credential-store or subprocess detail

#### Scenario: Incompatible repository is blocked

- **WHEN** the configured repository is private, missing, has an invalid manifest, or does not accept the selected publication contract
- **THEN** status is `blocked` with stable sanitized target issue codes

### Requirement: Dataset target compatibility is versioned

A ready target MUST contain `.mosga-dataset.json` at the exact resolved default-branch head. The manifest SHALL have supported `kind` and `contractVersion`, a non-empty unique accepted-schema list, and a concrete non-placeholder license. Preview SHALL require every selected record schema to be accepted and SHALL seal the exact repository ID, manifest identity, default branch, and base commit.

#### Scenario: Compatible manifest is accepted

- **WHEN** the exact upstream base commit contains a supported manifest whose schema list accepts every selected session and whose license is concrete
- **THEN** preview uses that manifest license and seals its identity with the base commit

#### Scenario: Placeholder license is refused

- **WHEN** the target manifest license is empty or a placeholder such as `TBD`
- **THEN** target readiness/preview is refused as `target_incompatible`

#### Scenario: Base or manifest changes after preview

- **WHEN** the upstream default-branch head or compatibility manifest differs at submit from the sealed target snapshot
- **THEN** pre-push submit returns `preview_stale` and performs no workspace or remote mutation

### Requirement: Direct and fork routes keep upstream and push explicit

The canonical upstream SHALL always be the pull-request destination. The push repository SHALL be upstream when writable; otherwise it SHALL be the authenticated actor’s fork whose GitHub source identity matches upstream. If no valid fork exists, preview SHALL report an on-submit fork without claiming read-only proof of actor-specific fork policy; only explicit confirmed submit may attempt creation, and policy refusal SHALL return a stable sanitized `fork_failed`.

#### Scenario: Existing verified fork is selected

- **WHEN** the actor cannot push upstream but has a fork whose source identity equals the upstream repository ID
- **THEN** preview reports route `fork`, that existing push repository, and `willCreateFork: false`

#### Scenario: Fork creation is previewed but not performed

- **WHEN** the actor needs a new fork and requests preview
- **THEN** preview reports the predicted push repository and `willCreateFork: true` without creating any GitHub object

#### Scenario: Unrelated repository is not accepted as a fork

- **WHEN** an actor-owned repository has the expected name but its source identity does not match upstream
- **THEN** the daemon refuses that route and does not push to it

### Requirement: Unified sealed publication preview

The daemon SHALL expose one preview operation accepting 1–500 review IDs, with N=1 and N>1 using the same validation, review/gate application, publisher compiler, target resolution, response, and later submit flow. It SHALL validate and deterministically deduplicate IDs, attribute missing/locked reviews, compile one `ContributionBundle`, and retain an opaque expiring seal containing exact file contents, bundle contract/digest, review selection, compiler options, target revision/snapshot, and base/push route. The HTTP preview SHALL omit exact file contents.

#### Scenario: One review uses the unified flow

- **WHEN** preview receives one unlocked review ID
- **THEN** it returns the same `PublicationPreview` contract and sealed-publication path used for multiple reviews

#### Scenario: Preview returns UI-safe exact-content summaries

- **WHEN** a valid selection is previewed
- **THEN** the response includes publication ref/expiry, upstream/push/mode/base, PR metadata, engine pins, content digest, and per-file path/byte/hash summaries but no `files[].contents`

#### Scenario: Invalid collection is refused early

- **WHEN** preview receives zero IDs, more than 500 IDs, an unknown review, or a locked review
- **THEN** it returns a stable attributed error before creating a seal or performing any publication mutation

### Requirement: Preview has no write side effect

Preview SHALL perform no filesystem write, local Git mutation, GitHub write, fork creation, branch push, or pull-request creation. It MAY perform GitHub read-only actor/repository/manifest/permission/fork inspection. Seals SHALL remain bounded and in memory with a finite TTL; daemon restart SHALL require a new preview.

#### Scenario: Preview is observed through recording adapters

- **WHEN** preview succeeds or refuses through recording filesystem, Git, and GitHub adapters
- **THEN** every write/mutation call count remains zero

#### Scenario: Expired or lost seal cannot submit

- **WHEN** the TTL passes or the daemon restarts before submit
- **THEN** submit returns `preview_expired` or `preview_not_found` and performs no mutation

### Requirement: Publisher bundle invariants are independently validated

Before sealing and again before first submit mutation, the backend SHALL accept only the known bundle contract and SHALL recompute every UTF-8 byte count, exact-content SHA-256, total, and contract-v1 aggregate digest. It SHALL validate record/file associations, canonical uniqueness/order, safe branch grammar, normalized `data/`-contained POSIX paths, portable path components, platform-canonical collision freedom, and non-empty engine pins. Type declarations or publisher provenance alone SHALL NOT authorize a path or byte sequence.

#### Scenario: Tampered contents or digest are refused

- **WHEN** a bundle file’s contents, byte count, content hash, total, or aggregate digest does not satisfy the contract
- **THEN** preview/submit fails closed before any path is written

#### Scenario: Platform path collision is refused

- **WHEN** distinct bundle paths would resolve to the same destination on the host filesystem or use a reserved device component
- **THEN** the backend returns a sanitized validation failure and writes neither file

#### Scenario: Reviewed publisher paths remain valid

- **WHEN** a valid bundle contains well-formed Unicode, percent-looking identifiers, and normalized encoded paths produced by the reviewed publisher
- **THEN** validation preserves their exact paths and bytes without decoding or re-slugifying them

### Requirement: Confirmed submit is bound to ref, revision, and digest

Submit SHALL accept only `publicationRef`, `targetRevision`, `contentDigest`, and literal `confirmPublic: true`. Before the first journal/workspace/remote write, it SHALL validate the seal and TTL, request bindings, current target revision, current review existence/gates, recompilation contract/digest/file commitments using the sealed trusted options, current target snapshot, complete bundle invariants, and final exact-byte pre-check. Any stale value SHALL refuse without mutation.

#### Scenario: Target revision changed

- **WHEN** submit names a seal whose target revision is no longer current
- **THEN** it returns `target_changed` and performs no workspace, fork, push, or PR mutation

#### Scenario: Review content changed after preview

- **WHEN** a selected review’s current stamped content recompiles to a different contract/digest or file commitment
- **THEN** submit returns `preview_stale` and performs no mutation

#### Scenario: Extra delivery authority is rejected

- **WHEN** submit includes a workspace, URL, remote, base/head, branch, fork, token, command, or any other extra field
- **THEN** strict request validation rejects the body without using the extra value

### Requirement: Managed workspace writes only exact sealed bytes

After all pre-write gates pass, the daemon SHALL create or recover a marker-owned workspace beneath a locally derived managed root, based on the sealed upstream base commit. For every file it SHALL prove root containment, reject symlink/reparse-point/junction traversal, write the exact sealed UTF-8 contents, re-read and verify byte/hash identity, and stage paths with explicit `git add --`. Cleanup SHALL operate only on marker-owned resolved paths beneath the managed root.

#### Scenario: Exact files are committed

- **WHEN** confirmed submit receives a valid seal
- **THEN** the resulting Git tree contains each sealed path with byte-for-byte equal contents and matching hashes before commit/push

#### Scenario: Symlink escape is refused

- **WHEN** any existing workspace component redirects outside the managed root
- **THEN** submit returns `workspace_corrupt` without writing through the link or deleting an unowned path

#### Scenario: HTTP cannot select the workspace

- **WHEN** any target/preview/submit request attempts to provide a local root or path
- **THEN** request validation rejects it and the daemon continues using only its locally derived managed root

### Requirement: Delivery uses explicit push and pull-request identities

The backend SHALL use fixed internal `upstream` and `push` remote semantics, argument-array subprocesses with `shell: false`, and an explicit push ref. Pull-request lookup SHALL use a semantic GitHub API read and verify sealed upstream repository ID/full name, base ref, push repository full name, and head ref. Creation SHALL identify `--repo <upstream>` and `--base <sealed-base>` explicitly, using bare `--head <sealed-branch>` for direct routes and `--head <authenticated-user>:<sealed-branch>` for fork routes. It SHALL derive no value from cwd or `origin`. Credentials SHALL remain in the GitHub/ephemeral Git-auth adapter and SHALL NOT enter URLs, arguments, persistence, logs, or HTTP.

#### Scenario: Direct route remains explicit

- **WHEN** the actor can write upstream
- **THEN** the branch is pushed through the explicit `push` remote to upstream and the PR is opened explicitly against upstream/base/head

#### Scenario: Fork route remains explicit

- **WHEN** submit uses a verified existing or newly created fork
- **THEN** the branch is pushed only to that fork while the PR repository/base remain the sealed upstream

#### Scenario: Implicit origin is unavailable

- **WHEN** the managed repository has no `origin` or has an unrelated `origin`
- **THEN** delivery behavior is unchanged because no operation consults it

### Requirement: Submit retry and recovery return one immutable receipt

The backend SHALL serialize publication submits, atomically journal validated, committed, fork-ready, pushed, PR-observed, and completed phases, and atomically persist an immutable receipt. A retry for the same ref/revision/digest SHALL return the existing receipt. Recovery SHALL compare a pre-existing remote branch’s full Git tree to the journal, adopt an existing exact upstream/base/head PR, and SHALL NOT force-push a conflicting branch or create a duplicate PR.

The first confirmed attempt SHALL complete every current review, gate, content, target, and exact-byte check before writing `validated`. Once that strict versioned journal exists, its embedded sealed publication SHALL be the recovery authority at every phase; recovery SHALL NOT require the volatile preview or review stores and SHALL NOT re-resolve or retarget to later target configuration.

#### Scenario: Receipt retry is idempotent

- **WHEN** the same confirmed submit is retried after a receipt exists
- **THEN** it returns the same PR number, URL, commit SHA, branch, target, and digest without another fork, push, or PR create

#### Scenario: Crash after push is recovered

- **WHEN** a process stops after the exact branch is pushed but before receipt persistence
- **THEN** retry verifies the remote tree, finds or creates the exact upstream/base/head PR once, and persists one receipt

#### Scenario: Daemon restart before push is recovered

- **WHEN** the daemon restarts with empty in-memory preview and review stores after journaling `validated`, `committed`, or `fork_ready`
- **THEN** retry validates the durable seal and phase bindings, resumes the sealed upstream/base/head publication, and never retargets to a later configured repository

#### Scenario: Crash after PR creation is recovered

- **WHEN** PR creation succeeded but its response or journal transition was lost
- **THEN** retry finds and adopts that PR rather than creating another

#### Scenario: Branch content conflicts

- **WHEN** the sealed remote branch name exists with a different full tree
- **THEN** submit returns `branch_conflict` and never overwrites or force-pushes it

### Requirement: Publication HTTP contract exposes only safe state

The daemon SHALL expose `GET /api/publish`, `PUT /api/publish/target`, `DELETE /api/publish/target`, `POST /api/publish/preview`, and `POST /api/publish/submit`. Responses SHALL use discriminated typed status/preview/receipt shapes and stable sanitized errors. No response SHALL contain a local path, token, raw stdout/stderr, command sequence, manual fallback, exact contribution contents, or uncurated external exception text.

#### Scenario: Successful receipt is auditable and safe

- **WHEN** publication completes
- **THEN** the receipt contains publication ref, target revision, upstream, push repository, mode, base branch/commit, contribution branch/commit, PR number/URL, record count, digest, and submission time only

#### Scenario: External failure is sanitized

- **WHEN** GitHub, Git, filesystem, or process adapters fail with sensitive raw text
- **THEN** HTTP returns a stable phase/code/message/retryability contract without that raw text

### Requirement: Automated tests never write to real GitHub

GitHub SHALL be treated as a true-external semantic port. Automated status/preview/submit/recovery tests MUST use fake GitHub behavior and SHALL create no real fork, remote branch, push, or pull request. Filesystem, Git, process, clock, IDs, stores, and locks SHALL be substitutable; local Git integration tests MAY use temporary local repositories with no network remote.

#### Scenario: Full fork publication uses fakes

- **WHEN** automated tests cover on-submit fork, push, PR creation, retry, and recovery
- **THEN** all GitHub effects are recorded by a fake adapter and no real external repository is contacted for a write
