## Why

The approved GitHub publication redesign replaces a caller-selected local clone with one canonical GitHub `owner/repo` target and a daemon-owned delivery boundary. With the publisher now producing a pure, exact-byte `ContributionBundle`, the daemon must safely bind that content to a resolved upstream, a managed workspace, and an idempotent pull-request receipt without exposing local paths, credentials, commands, or external error text over its no-auth loopback API.

## What Changes

- **BREAKING** Replace `--data-repo`, `AppOptions.dataRepoPath`, local-clone preflight, and the old per-review/batch plan-stage-submit routes with one target-aware `inspect/configure/clear/preview/submit` publication flow.
- Persist exactly one canonical github.com `owner/repo` upstream atomically with a monotonic revision; reject local paths, arbitrary hosts, credentials, remotes, branches, clone URLs, and workspace configuration.
- Add a semantic GitHub port and production `gh` adapter that resolve actor, repository compatibility, default branch, permissions, direct push versus existing/on-submit fork, existing pull requests, and pull-request creation while keeping fork creation strictly submit-only.
- Add sealed, expiring previews over 1–500 deduplicated `reviewIds`, the Publisher `ContributionBundle` contract/digest and exact `files[].contents`, a target revision/snapshot, and the resolved upstream base commit/branch. Preview may use read-only GitHub inspection but performs no filesystem, Git, or GitHub write.
- Add daemon-managed repository cache/worktrees under a locally derived trusted root. Submit revalidates review/gate/content/target state, repeats the mandatory exact-byte pre-check, validates every bundle path/hash/byte invariant, writes only the sealed bytes with containment and symlink/junction defenses, commits, explicitly pushes to the `push` remote, and explicitly opens a PR against `upstream`.
- Persist a crash-recoverable journal and immutable receipt so retrying the same confirmed preview returns the same PR rather than creating duplicates; recover the pushed-without-receipt and PR-created-without-receipt windows by semantic pull-request lookup.
- Add same-origin and JSON content-type guards for every mutating no-auth loopback route, plus stable sanitized publication errors that never expose a workspace path, token, raw stderr, command, or manual fallback.
- Add a versioned `.mosga-dataset.json` compatibility manifest and template checks for accepted record schema, non-placeholder license, repository visibility, default branch, and publication contract support.
- Use fake GitHub adapters and substitutable local Git/filesystem/process seams in automated tests; no test creates a real fork, branch, push, or pull request.
- Remove obsolete local-clone and manual-command guidance from backend-owned CLI/help, daemon/root documentation, and the community repository template. No migration, deprecation, compatibility wrapper, legacy endpoint, or `--data-repo` fallback is provided.

## Capabilities

### New Capabilities

- `github-publication`: Single-target configuration and readiness, semantic GitHub direct/fork resolution, sealed read-only preview, daemon-managed exact-byte delivery, recovery, idempotent receipts, and the safe daemon HTTP contract.

### Modified Capabilities

- `review-daemon`: Replace the local data-repository startup surface with injected publication dependencies and harden all mutating loopback routes with same-origin/content-type enforcement and sanitized unexpected errors.
- `pr-submission`: Move target-aware Git/GitHub delivery into the publication backend with explicit upstream/base/head semantics, fork-on-submit behavior, recovery, and real PR receipts; remove manual and local-clone behavior.
- `publish-batch`: Replace distinct single/batch plan-stage-submit routes with one `reviewIds` preview/submit flow for 1–500 reviews.
- `publish-precheck`: Make bundle validation and the final exact-record-byte pre-check a non-bypassable submit gate before any managed-workspace or remote mutation, with rule-count-only refusals.
- `community-repo-template`: Add and validate the versioned `.mosga-dataset.json` target-compatibility manifest and remove obsolete manual local-clone publication guidance.

## Impact

- Primary backend code: `packages/daemon/src/app.ts`, `cli.ts`, `http.ts`, `publish.ts` (replacement), new publication target/store/GitHub/workspace/journal modules, daemon exports, and focused tests.
- Publisher boundary: consume the committed `compileContributionBundle`, `ContributionBundle`, contract-version/digest, exact file contents, engine pins, and path-safety contract; any Git/process runner used for delivery becomes backend-owned rather than a publisher public API.
- Template/docs: `templates/community-data-repo/**`, `packages/daemon/README.md`, and root CLI guidance; no UI files are changed in this child.
- External dependency: GitHub is the only true-external semantic port and github.com is the only supported host in the first release. Production may invoke `git` and `gh`; automated tests use fakes and local temporary repositories only.
- Source context: the approved decisions come from `rasen/office-hours/github-publication-target-redesign.md`, the parent planning context, and the shipped publisher-core contract/review/ship evidence.
