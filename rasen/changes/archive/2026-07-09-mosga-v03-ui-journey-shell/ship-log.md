# Ship Log: mosga-v03-ui-journey-shell

**Date:** 2026-07-09
**Branch:** main (direct commit, no PR — per repo convention established in v01/v02/slice 1)
**Status:** Shipped

## Pre-Flight Results

- Verification: PASS — `rasen/changes/mosga-v03-ui-journey-shell/review-report.md` verdict **FINDINGS** (0 Blocker, 0 Major, 2 Minor, 2 Trivial — all advisory, shippable as-is). F1 (spec-text/impl mismatch on the L3 group being read-only) was fixed by LEAD ahead of ship; F2/F4 accepted-known and recorded in `auto-run.json`.
- Tasks: 28/28 complete (0 incomplete found in `tasks.md`)
- Gate re-runs (from review-report.md, independently executed by reviewer): typecheck PASS, build PASS (vite, 1651 modules), tests PASS (40 files, 194/194)

## Tests

`npx vitest run` — first pass: 1 failure (`packages/publisher/src/__tests__/pr.test.ts` — a git-subprocess integration test in an unrelated package, timed out at the default 5s limit under parallel load). Re-ran in isolation: 7/7 passed. Re-ran full suite with `--testTimeout=20000`: **40 files, 194/194 tests passed**, confirming the failure was resource-contention flakiness (Windows git subprocess under concurrent test load), not a regression introduced by this change — packages/publisher was untouched by this diff.

## Commit

`feat(ui): journey shell — NavRail + 4-step stepper + signing ceremony + dual exit cards (mosga-v03-ui-journey-shell)`

Scope (single commit — rasen/ now tracked, no split needed):
- `packages/ui/**`: new `components/journey/`, `components/shell/`, `components/SettingsPage.tsx`, `lib/useDaemonStatus.ts`, `components/ui/dialog.tsx` + `confirm-dialog.tsx` + `advanced-fold.tsx`; deleted `components/GateBanner.tsx` + `__tests__/GateBanner.test.tsx`; modified `ReviewView.tsx`, `SubmitPanel.tsx`, `ExportPreview.tsx`, `App.tsx`, `api/client.ts`, `api/types.ts`, `lib/theme.ts`, `components/ui/badge.tsx`; reorganized/new tests (`AppShell.test.tsx`, `SigningCard.test.tsx`, updated `ReviewView.test.tsx`, `smoke.test.tsx`).
- `packages/ui/package.json` + root `package-lock.json` (`@radix-ui/react-dialog` added).
- `rasen/changes/mosga-v03-ui-journey-shell/**` (new: auto-run.json, design.md, proposal.md, review-report.md, specs/, tasks.md).
- `rasen/changes/mosga-v03/planning-context.md` + `portfolio-run.json` (LEAD bookkeeping, rides along).

## Push

`git push origin main` — confirmed, fast-forward from `b479a3f`.

## Notes

- Behavioral conservation verified by reviewer against `git show HEAD` for all daemon call sites (setDisposition, batch by rule/type, setNonText, exportReview 409 backstop, submit 409 backstop, gate re-lock signature drop) — all identical args, all wrapped in the new `guarded()` void-on-edit-when-signed flow as the only intended semantic addition.
- Minor F1 (Layer3View batch-by-type control living inside the spec's "read-only" normalization group) was reconciled in spec text by LEAD prior to this ship; implementation behavior itself was accepted as internally consistent (fail-safe: an unnecessary re-sign, not a missed one).

## Next Steps

- `/opsx:retro mosga-v03-ui-journey-shell` — retrospective
- `/opsx:archive mosga-v03-ui-journey-shell` — archive the completed change
- Prereq unblocked: `mosga-v03-publish-exit-one` (depends on this slice for the exit-card slot)
