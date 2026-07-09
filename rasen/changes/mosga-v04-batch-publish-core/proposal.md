## Why

Slice 1 gives the UI a multi-select picker and a per-session review queue, but the exits are still strictly single-session: the publisher plans exactly one record per branch (`contrib/<alias>/<sessionId>`, `recordCount` always 1) and the daemon publish routes take one `reviewId`. A user who just signed 15 sessions would have to open 15 PRs. The approved design (`rasen/office-hours/session-picker-batch-journey.md` B3) closes this with a batch publish core: the publisher learns to plan/stage/submit N records as ONE branch/commit/PR, and the daemon exposes batch routes over it. This slice is backend-only; the batch exit UI (slice 3) consumes it.

## What Changes

- **Publisher batch planning** (`packages/publisher/src/batch.ts`, new): `planBatchContributionAsync(sessions, options)` runs the export + MANDATORY pre-check for EVERY session (no fail-fast — refusals aggregate so the UI can show all of them at once) and returns a `BatchContributionPlan`: N exported records, ONE deterministic branch, one commit message, one batch PR title/body (summary table: sessionId / messages / record path, plus the shared engine stamp and the attestation/consent blocks), `stagedFiles` = N×(record + provenance sidecar), and the exact manual command sequence.
- **Deterministic batch branch**: N=1 degrades to the existing single-session plan semantics (same branch `contrib/<alias>/<sessionId>`, same title/body — implemented by delegating to the single plan); N>1 uses `contrib/<alias>/batch-<hash8>` where `hash8` = sha256 of the sorted sessionId list — the same selection always maps to the same branch, so a retry hits the existing `branch_exists` residue semantics unchanged.
- **Alias consistency is asserted**: all sessions in a batch MUST share `meta.contributorAlias`; a mismatch throws (config error) rather than silently picking one.
- **Aggregated refusal type**: `BatchPublishRefusedError` carrying per-session `{ sessionId, blockingFindings }` for every refused session.
- **Batch stage/submit** (`stageBatchContributionAsync` / `submitBatchContributionAsync`): one `git checkout -b`, N record+sidecar writes + the PR body file, one `git add`/`commit`; one `git push` + one `gh pr create`. Async-only (the daemon path); no sync CLI batch (out of scope, Later).
- **Daemon batch routes** (`packages/daemon/src/publish.ts` extended): `POST /api/publish/batch/plan|stage|submit` with body `{ reviewIds: string[] }` (zod: 1–20, deduped). Per-review checks mirror the single routes and NAME the offending review: unknown → 404 with `reviewId`; locked gate → 409 `GATE_LOCKED` with `reviewId` + gate. Pre-check refusal → 422 `precheck_refused` with `blockingBySession: [{ reviewId, sessionId, blockingByRule }]` (rule-aggregated counts, never raw values). All other typed errors (`data_repo_unconfigured`/`git_unavailable`/`repo_dirty`/`branch_exists`/`gh_unauthenticated`/`push_rejected`/`publish_in_flight`) reuse the existing taxonomy verbatim.
- **Shared mutex + batch stage state**: the batch routes share the SAME single `publishInFlight` flag as the per-review routes (one local user, one clone); batch stage state is keyed by the sorted deduped reviewIds joined with `,` in the same closure map.
- **UI-safe batch plan**: enumerated fields only, record bytes EXCLUDED — per-record `{ sessionId, recordPath, provenancePath, recordBytes, contentHash, messages }` + totals + the daemon-derived `compareUrl`, mirroring the single-plan discipline.
- **Unchanged**: the per-review publish routes, preflight, `dataRepoPath` trust model, and every existing publisher export.

## Capabilities

### New Capabilities

- `publish-batch`: the publisher's multi-record batch contribution plan (aggregated mandatory pre-check, deterministic batch branch, alias consistency, batch PR body) with async stage/submit, and the daemon's batch publish routes (reviewIds validation, per-review gate/404 attribution, aggregated refusal payload, shared single-flight mutex, UI-safe batch plan subset).

## Impact

- **Modified packages**: `packages/publisher` (new `batch.ts`, small helper exports from `pr.ts`/`export.ts` if needed), `packages/daemon` (`publish.ts` + batch route registration; `app.ts` untouched except none — routes come from `createPublishRoutes`). ZERO UI change (slice 3).
- **Tests**: publisher `batch.test.ts` (plan determinism + N=1 degradation + alias mismatch + refusal aggregation + stage/submit against a temp dir with a recording fake runner — no real git/gh/network); daemon `publish-batch.test.ts` (fake `AsyncCommandRunner` + temp `dataRepoPath`, mirroring `publish.test.ts` patterns: happy path, per-review 404/409 attribution, refusal aggregation, mutex shared with single routes, branch_exists residue). NO new real-git tests (Windows timeout flake, v03 follow-up #2).
- **Out of scope**: any UI change; sync/CLI batch; receipt persistence; per-review route changes.
