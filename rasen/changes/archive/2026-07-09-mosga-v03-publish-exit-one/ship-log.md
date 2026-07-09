# Ship Log: mosga-v03-publish-exit-one

**Date:** 2026-07-09
**Branch:** main (direct commit, no PR — per repo convention established in v01/v02/slice 1/slice 2)
**Status:** Shipped

## Pre-Flight Results

- Verification: PASS — `rasen/changes/mosga-v03-publish-exit-one/review-report.md` verdict **CLEAN** (0 Blocker, 0 Major, 2 Minor, 1 Trivial — all non-blocking). M1/M2/T1 accepted-known, recorded in `auto-run.json`. Reviewer noted this as the portfolio's security-heaviest slice (a daemon that mutates the user's local git clone) and reported the security model holds under adversarial inspection.
- Tasks: 25/25 complete (0 incomplete found in `tasks.md`)
- Gate re-runs (from review-report.md, independently executed by reviewer): typecheck PASS (all 7 packages), tests PASS (43 files, 219/219, 21.6s), spec validate PASS ("Change is valid")

## Tests

`npx vitest run --testTimeout=20000` (root, sanctioned mitigation for the known-flaky `pr.test.ts` git-subprocess timeout under parallel load) — **43 files, 219/219 tests passed**, 0 failed.

## Commit

`feat(publish): 出口① HF publish wiring — daemon plan/stage/submit routes + async runner + 3-step wizard (mosga-v03-publish-exit-one)`

Scope (single commit):
- `packages/daemon/**`: new `src/publish.ts` + `src/__tests__/publish.test.ts`; modified `package.json`, `src/app.ts`, `src/cli.ts`.
- `packages/publisher/**`: new `src/__tests__/async-runner.test.ts`; modified `src/index.ts`, `src/pr.ts`, `src/runner.ts`.
- `packages/ui/**`: new `components/journey/PublishWizard.tsx` + its test, `lib/usePreflight.ts`; modified `ReviewView.tsx`, `SettingsPage.tsx`, `DispositionWorkspace.tsx`, `ExitCards.tsx`, `api/client.ts`, `api/types.ts`, `__tests__/AppShell.test.tsx`, `__tests__/ReviewView.test.tsx`.
- Root `tsconfig.base.json` + `vitest.config.ts`.
- `rasen/changes/mosga-v03-publish-exit-one/**` (new: auto-run.json, design.md, proposal.md, review-report.md, specs/, tasks.md).
- `rasen/changes/mosga-v03/{planning-context.md,portfolio-run.json}` (LEAD bookkeeping, rides along).

## Push

`git push origin main` — confirmed, fast-forward from `92ca67d`.

## Notes

- This is the final slice of the mosga-v03 portfolio (design-system tokens -> journey/IA shell -> this HF-publish wiring), completing the exit-card slot dependency from slice 2.
- The publisher's `pr.test.ts` git-subprocess timeout flakiness (seen in slice 2's ship) is a known, unrelated-package issue; `--testTimeout=20000` is the standing mitigation, not a new workaround for this slice.

## Next Steps

- Archive: `rasen archive mosga-v03-publish-exit-one -y --json`
- `/opsx:retro mosga-v03-publish-exit-one` — retrospective
- Portfolio-level retro once all 3 slices are archived
