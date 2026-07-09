# Ship Log: mosga-v02-direct-submit

**Date:** 2026-07-09
**Mode:** Direct commit to `main` + push (solo-owner repo, serial dependent slices — no PR, no merge ceremony; matches v0.1 and mosga-v02-sanitizer-coverage precedent)
**Branch:** main
**Status:** Shipped — slice 2 of the mosga-v02 portfolio (出口② API direct-submit)

## Pre-Flight Results

- **Verification evidence:** `openspec/changes/mosga-v02-direct-submit/review-report.md` — reviewer-1 (not the author). Round 1: **APPROVE WITH FINDINGS** — 0 Blockers, 1 Major (assistant `thinking` silently dropped on OpenAI-format conversion — a fidelity gap, not a security/privacy issue), 2 Minor (pricing fallback not disclosed; unmapped submit errors echoed raw messages), 2 Trivial. All four ranked security-critical invariants (key isolation, backstop integrity, consent gate, mapper/dispositions parity) were CLEAN in round 1. Round 2 (delta re-review, scoped to the fix delta): **CLEAN** — Major-1 resolved via `foldThinkingIntoText` + a defensive null/empty-content guard, backed by two genuine asserting tests; Minor-1 resolved via disclosed `pricingSource: 'provider' | 'default'`; Minor-2 resolved via stable key-free error codes on all submit error paths; Trivial-1 also cleaned up. Round 2 re-verified all four security invariants still hold and confirmed no regression. No remaining findings — approved.
- **Tasks:** `openspec/changes/mosga-v02-direct-submit/tasks.md` — 29/29 subtasks complete (`- [x]`), 0 incomplete.
- **Git status:** working tree had the new `@mosga/direct-submit` package, contracts/daemon/ui changes, root config changes, the office-hours write-back, and the change directory as untracked/modified ahead of this commit. On branch `main`, not detached. The untracked `openspec/changes/mosga-v02-tauri-shell/` scaffold (slice 3, not yet worked) was correctly left out of this commit.

## Gates Re-Run (this session, real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — all workspaces clean under `strict`, including the new `@mosga/direct-submit` package. |
| `npm run build` | PASS — all packages build clean; `@mosga/direct-submit` emits ESM (`index.js`, `cli.js`) + `.d.ts` via tsup; `@mosga/ui` emits a Vite production bundle. |
| `npx vitest run` | PASS — 38 test files, **184/184 tests** green (up from 155 at the prior slice; +29 new tests across direct-submit's 5 test files and daemon's `submit.test.ts`). |
| `node .../rasen.js validate mosga-v02-direct-submit --strict --json` | PASS — 1/1 items valid, 0 issues. |

## Pre-Commit Sanity Scan

- Scanned the new package's test fixtures (`packages/direct-submit/src/__tests__/_fixtures.ts`) and the new `packages/daemon/src/__tests__/submit.test.ts` for hardcoded secret-like literals. No real secrets: both reference obviously-fake canary constants consistent with the established repo convention — `FAKE_GITHUB_PAT` (`ghp_...`) and `FAKE_AWS_KEY` (`AKIAFAKE...`) reused from prior slices, plus a new `FAKE_PROVIDER_KEY`/`FAKE_KEY` (`sk-FAKEfakeFAKEfake...`) used specifically to assert the provider key never leaks into the scanned/sent outbound body, the receipt, or the consent record — the exact security invariant this slice's review focused on.
- The regex/consent fixtures in `packages/direct-submit/src/` (backstop windowing, consent content-hash, provider key resolution) are the package's actual implementation and test surface, not planted secrets — deliberate per the shipping brief, left untouched.
- Confirmed `git status` before commit showed exactly the file set specified for this slice as dirty; `openspec/changes/mosga-v02-tauri-shell/` was left untracked and excluded from this commit.

## Commit Scope

Staged and committed:
- `packages/direct-submit/**` (new package: backstop, consent, estimate, keys, providers, reconstruct, submit, transport, versioning, CLI, tests)
- `packages/contracts/src/contribution.ts` (new) + `packages/contracts/src/index.ts` (export wiring)
- `packages/daemon/package.json`, `packages/daemon/src/app.ts` (three new routes: providers/estimate/submit), `packages/daemon/src/__tests__/submit.test.ts` (new)
- `packages/ui/src/components/SubmitPanel.tsx` (new), `packages/ui/src/components/ReviewView.tsx`, `packages/ui/src/api/{client.ts,types.ts}`, `packages/ui/src/__tests__/ReviewView.test.tsx`
- Root wiring: `package.json`, `package-lock.json`, `tsconfig.base.json`, `vitest.config.ts`
- `openspec/office-hours/agent-session-data-contribution.md` (Open Question #3 write-back, decided 2026-07-09: informed-consent + full-retention for the direct-submit channel)
- `openspec/changes/mosga-v02/planning-context.md` (slice-2 findings)
- `openspec/changes/mosga-v02-direct-submit/**` (proposal, design, specs, tasks, review-report, auto-run.json, this ship-log)

Excluded (left untracked, scaffold for a later slice):
- `openspec/changes/mosga-v02-tauri-shell/`

## Commit

- **Hash:** `19f774fbafe20f0a9f23871ca2a10b3d1d614759` (short: `19f774f`)
- **Message:** `feat(direct-submit): 出口② API direct-submit — consent-gated replay with outbound raw-bytes backstop (mosga-v02-direct-submit)`
- **Pushed:** `origin/main` updated `3d0bcf6..19f774f` (fast-forward).

## Archive

- **Archived to:** `openspec/changes/archive/2026-07-08-mosga-v02-direct-submit/` (date is UTC-derived by `rasen archive`; local archive date was 2026-07-09 +0800).
- **Specs synced:** a new `openspec/specs/direct-submit/spec.md` capability spec (7 requirements: gate-unlocked-only consumption, pre-send raw-bytes backstop with no allow-escape, content-bound consent, provider targeting with a never-leaked key, request reconstruction/format conversion, replay modes + cost estimation, contribution meta message) and 3 requirements ADDED to `openspec/specs/review-daemon/spec.md` (provider list, cost-estimate, and gated submission endpoints), appended after the 9 pre-existing requirements with none altered. Totals per `rasen archive --json`: 10 added, 0 modified, 0 removed.
- **Merge verification:** manually read both merged spec files. `direct-submit/spec.md` matches the delta's 7 requirements verbatim with a Purpose placeholder (`TBD - created by archiving...`, standard for a first-time capability spec). `review-daemon/spec.md` retains all 9 original requirement headings unchanged (`grep -n "^### Requirement"` — 12 total, in original order, 3 new ones appended at the end).
- **Validation after archive:** `rasen validate --all --json` — 20/23 items pass; both synced specs (`direct-submit`, `review-daemon`) pass with 0 errors. The 3 failing items (`mosga-v01`, `mosga-v02` portfolio-tracking directories with no spec deltas by design, and the untracked `mosga-v02-tauri-shell` scaffold) are pre-existing and unrelated to this archive.
- **Archive commit hash:** `bc91cb3aeb9314f99d4ac5b965bdeb0e11d1db13` (short: `bc91cb3`) — `chore(openspec): archive mosga-v02-direct-submit`. The lead's uncommitted `auto-run.json` edit (made before this archive ran) moved into the archive directory as-is and is included in this commit unmodified.
- **Pushed:** `origin/main` updated `f75869d..bc91cb3`.

## Next Steps (not done in this run)

- Run-state accounting (`openspec/changes/mosga-v02/portfolio-run.json` updates, marking this slice's child status `done` with the shipped+archived commit hashes) is owned by the lead, not the shipper/archiver, per instruction.
