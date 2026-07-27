## 1. Unified bundle contract

- [x] 1.1 Add the versioned `ContributionBundle`, file/record summary, compiler-options, and rule-aggregated refusal types in a target-independent publisher contribution module, including the 1–500 record limit.
- [x] 1.2 Implement collection validation and locale-independent canonical ordering: non-empty/bounded input, one exact contributor alias, unique raw session IDs, and no derived record/provenance path collisions after slugification.
- [x] 1.3 Export every canonical session in memory and run the mandatory pre-check on each exact `record.fileContents`, aggregating all refusals by session and rule without returning match previews or a partial bundle.

## 2. Exact bytes and deterministic metadata

- [x] 2.1 Build canonical record/provenance `ContributionBundleFile` entries with exact UTF-8 contents, byte counts, per-file SHA-256 hashes, path ordering, record summaries, totals, and the shared engine identity.
- [x] 2.2 Implement the contract-v1 aggregate digest over the canonical `{ path, bytes, contentHash }` manifest and cover the algorithm with fixed test vectors, including multibyte UTF-8 content.
- [x] 2.3 Consolidate single/batch commit-message and PR-title/body rendering into the unified compiler, remove wall-clock and target-state inputs, and derive content-bound `contrib/<alias>/<sessionId|batch>-<digest8>` branches.

## 3. Remove publisher-owned delivery

- [x] 3.1 Replace the public single/batch plan exports in `packages/publisher/src/index.ts` with the unified compiler contract; remove the old plan, stage, submit, result, target-repo, target-branch, `ghAvailable`, manual-command, PR-body-file, write-helper, and delivery-runner exports with no compatibility wrappers.
- [x] 3.2 Remove or reduce the old `pr.ts` and `batch.ts` implementations so no publisher planning path writes files, probes Git/`gh`, executes commands, or performs Git/GitHub delivery; leave any future subprocess runner module unexported and unused by the pure compiler.
- [x] 3.3 Update `mosga-publish` and package metadata to stop advertising or accepting target-repo preparation, `--stage`, and manual Git/`gh` fallback while retaining only non-delivery diagnostics that still use supported publisher APIs.

## 4. Contract verification

- [x] 4.1 Replace obsolete PR/batch/async-delivery tests with compiler tests covering N=1/N>1 unification, any-order deep determinism, canonical rows/files, alias/ID/path-collision validation, changed-content branch identity, and deterministic PR metadata.
- [x] 4.2 Add exact-byte safety tests covering the trailing newline, aggregate multi-record refusals with rule counts only, absence of partial output, and a guard that compilation performs no filesystem, process, network, workspace, or GitHub operation.
- [x] 4.3 Update publisher smoke/closure tests to end at a complete pure bundle and assert exact files, provenance/engine metadata, byte/hash totals, and the downstream-safe absence of path/target/command/availability/delivery fields.
- [x] 4.4 Run publisher-focused tests, `npm run typecheck -w @mosga/publisher`, and `npm run build -w @mosga/publisher`; record any expected repository-wide compile break solely at old daemon imports for the dependent publication-backend child rather than editing daemon/UI code in this change.
- [x] 4.5 Run strict Rasen validation for `github-publication-target-redesign-publisher-core` and confirm the implementation diff contains no daemon, UI, target, workspace, GitHub adapter, or live external repository changes.
