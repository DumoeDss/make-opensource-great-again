## Why

The approved GitHub publication redesign separates contribution content from delivery, but `@mosga/publisher` currently mixes both: even an in-memory plan requires a local clone path, probes `gh`, emits shell commands, and maintains separate single and batch flows. The publisher must become a pure, deterministic contribution-bundle compiler before the downstream publication backend can safely own targets, workspaces, Git, forks, pushes, and pull requests.

## What Changes

- **BREAKING** Replace the target-aware single and batch planning APIs with one pure contribution-bundle compiler that accepts one or more stamped sessions; N=1 is the same code path and contract as N>1.
- Define the downstream `ContributionBundle` interface: exact repo-relative file contents, per-file UTF-8 byte counts and SHA-256 hashes, a canonical aggregate content digest, deterministic content-bound branch/commit/PR metadata, record summaries, and the pre-check engine identity.
- Preserve the mandatory exact-byte pre-check for every exported record, aggregate all refused records before returning, and produce no partial bundle on refusal.
- Make the complete bundle deterministic for the same logical session set and compiler options, including stable record/file ordering and identical N=1 output regardless of which caller surface selected it.
- **BREAKING** Remove `targetRepo`, target-branch assumptions, `ghAvailable`, manual command emission, command-runner probes, file writes, staging, pushing, and PR creation from publisher planning and batch code.
- Retain sanitized-file export as an independent capability; move all workspace and Git/GitHub delivery responsibility to the later publication-backend child.
- Add contract and regression tests for purity, exact bytes/hashes/digest, determinism, N=1 unification, multi-record refusal aggregation, and the absence of filesystem/process/network side effects.

## Capabilities

### New Capabilities

- `contribution-bundle`: Pure compilation of one or more stamped sessions into the exact, prechecked, deterministic content-and-metadata bundle consumed by the publication backend.

### Modified Capabilities

- `publish-batch`: Replace the batch-only plan/stage/submit contract with N-record behavior of the unified pure bundle compiler.
- `pr-submission`: Remove Git/`gh`, local-clone staging, and manual-command responsibilities from `@mosga/publisher`; publisher output stops at target-independent PR metadata and exact contribution files.

## Impact

- Primary code: `packages/publisher/src/pr.ts`, `batch.ts`, `index.ts`, and their tests; export and pre-check primitives remain the safety foundation.
- Public API: current `ContributionOptions`/`ContributionPlan`/`BatchContributionPlan` and `plan*`/`stage*`/`submit*` exports are replaced rather than deprecated.
- Downstream contract: the publication-backend child consumes `ContributionBundle` and alone adds target revision, upstream/base/head, managed workspace, fork/push/PR behavior, sealed previews, and receipts.
- No daemon routes, UI behavior, target persistence, workspace implementation, GitHub adapter, or live external repository changes are included in this child.
- Source context: the approved decisions and slice boundary come from `rasen/office-hours/github-publication-target-redesign.md` and the parent change planning context.
