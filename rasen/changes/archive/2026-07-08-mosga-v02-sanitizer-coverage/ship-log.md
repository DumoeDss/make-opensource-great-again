# Ship Log: mosga-v02-sanitizer-coverage

**Date:** 2026-07-09
**Mode:** Direct commit to `main` + push (solo-owner repo, serial dependent slices — no PR, no merge ceremony; matches v0.1 precedent)
**Branch:** main
**Status:** Shipped — slice 1 of the mosga-v02 portfolio

## Pre-Flight Results

- **Verification evidence:** `openspec/changes/mosga-v02-sanitizer-coverage/review-report.md` — reviewer-1 (not the author), verdict **CLEAN** — 0 Blockers, 0 Major, 0 Minor, 2 informational Trivial notes (no action required). Reviewed against `proposal.md`, `design.md` (field-semantics table), `tasks.md`, `specs/sanitization-{scan,apply}/spec.md`, and `openspec/changes/mosga-v02/planning-context.md` (slice 1). Confirmed every field in the design semantics table receives its specified treatment, the projectKey recognizer is field-scoped and bounded (no ReDoS), no no-op leak, provenance immutability and stamp-override hold, and pseudonym consistency between `projectKey` and `cwd` is preserved.
- **Tasks:** `openspec/changes/mosga-v02-sanitizer-coverage/tasks.md` — 32/32 subtasks complete (`- [x]`) across all 9 sections (schema, scan, projectKey pseudonymization, apply, and 4 test sections, plus validate+record).
- **Git status:** working tree had the 4 modified sanitizer source files, 2 new test files, and the new change/portfolio directories as untracked/modified ahead of this commit. On branch `main`, not detached. Local `main` was 1 commit ahead of `origin/main` (a pre-existing session-handoff commit, `89d356c`) before this ship; both went out together in this push.

## Gates Re-Run (this session, real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — all 6 workspaces clean (contracts, session-readers, sanitizer, ui, daemon, publisher) under `strict`. |
| `npx vitest run` | PASS — 32 test files, **155/155 tests** green (includes the 12 new envelope-coverage tests). |
| `node .../rasen.js validate mosga-v02-sanitizer-coverage --json` | PASS — 1/1 items valid, 0 issues. |

## Pre-Commit Sanity Scan

- Scanned the two new test files (`scan-envelope.test.ts`, `envelope-coverage.test.ts`) for hardcoded secret-like literals. No new hardcoded secrets: both reference the pre-existing `FAKE_GITHUB_PAT` constant imported from the shared `_fixtures.js` / `_helpers.js` fixture modules (same convention as prior slices), used to plant obviously-fake canary secrets in `session.projectKey`, `session.sessionId`, `session.sourceId`, `meta.toolVersion`, `meta.contributorAlias`, `meta.exportedAt`, `meta.license`, and `schemaVersion` for detection-coverage assertions.
- No secrets or vendor rule files were touched by this diff (`vendor/gitleaks.toml` and other fixture canaries referenced in the shipping brief are pre-existing from earlier slices, not part of this change's diff).
- Confirmed `git status` before commit showed only the intended 4 sanitizer source files + 2 new test files + the change/portfolio directories as dirty; the two later-slice scaffolds (`openspec/changes/mosga-v02-direct-submit/`, `openspec/changes/mosga-v02-tauri-shell/`) were left untracked and excluded from this commit as instructed.

## Commit Scope

Staged and committed:
- `packages/sanitizer/src/{scan.ts,apply.ts,schemas.ts,detectors.ts}` — widened scan/apply coverage and the projectKey pseudonymization recognizer
- `packages/sanitizer/src/__tests__/scan-envelope.test.ts` (new)
- `packages/daemon/src/__tests__/envelope-coverage.test.ts` (new)
- `openspec/changes/mosga-v02-sanitizer-coverage/**` (proposal, design, specs, tasks, review-report, auto-run.json, this ship-log)
- `openspec/changes/mosga-v02/**` (planning-context.md, portfolio-run.json — new portfolio tracking files for the v0.2 series)

Excluded (left untracked, scaffolds for later slices):
- `openspec/changes/mosga-v02-direct-submit/`
- `openspec/changes/mosga-v02-tauri-shell/`

## Commit

- **Hash:** `c8349058314ab62e1960e5dddcc2dda4ef1d6038` (short: `c834905`)
- **Message:** `feat(sanitizer): envelope field coverage — scan meta.*/session identity fields + projectKey pseudonymization (mosga-v02-sanitizer-coverage)`
- **Pushed:** `origin/main` updated `902bb41..c834905` (fast-forward; includes both the prior session-handoff commit `89d356c` and this slice's commit `c834905`).

## Archive

- **Archived to:** `openspec/changes/archive/2026-07-08-mosga-v02-sanitizer-coverage/` (date is UTC-derived by `rasen archive`; local ship date was 2026-07-09 +0800).
- **Specs synced:** `openspec/specs/sanitization-scan/spec.md` (1 requirement MODIFIED — "Structure-aware traversal of the session" now covers `schemaVersion`, `meta.*`, and session identity fields, not only `cwd`/`title` — plus 2 requirements ADDED: envelope-field scan coverage parity with the publish-path raw-bytes backstop, and encoded project-key path pseudonymization) and `openspec/specs/sanitization-apply/spec.md` (2 requirements ADDED: disposition application covers the same session identity/provenance string fields; provenance fields are never auto-mutated outside the stamping step). Totals per `rasen archive --json`: 4 added, 1 modified, 0 removed.
- **Validation after archive:** `rasen validate --all --json` — both synced specs (`sanitization-scan`, `sanitization-apply`) pass with 0 issues. The 4 failing items in that run (`mosga-v01`, `mosga-v02` portfolio-tracking directories with no spec deltas by design, and the untracked `mosga-v02-direct-submit`/`mosga-v02-tauri-shell` scaffolds) are pre-existing and unrelated to this archive.
- **Archive commit hash:** `fdea46ce160bbee64c158e92a0e5a20661292a61` (short: `fdea46c`) — `chore(openspec): archive mosga-v02-sanitizer-coverage`.
- **Pushed:** `origin/main` updated `191788b..fdea46c`.

## Next Steps (not done in this run)

- Run-state accounting (`openspec/changes/mosga-v02/portfolio-run.json` updates, marking this slice's child status `done` with the shipped+archived commit hashes) is owned by the lead, not the shipper/archiver, per instruction.
