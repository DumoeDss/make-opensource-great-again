# Ship Log: mosga-v01-publish

**Date:** 2026-07-07
**Mode:** Direct commit to `main` + push (solo-owner repo, serial dependent slices — no PR, no merge ceremony; pre-authorized for continuous shipping)
**Branch:** main
**Status:** Shipped — final slice of the mosga-v01 portfolio (4/4)

## Pre-Flight Results

- **Verification evidence:** `openspec/changes/mosga-v01-publish/review-report.md` — round-0 review found 1 Blocker (B1: the mandatory pre-check scanned only a strict subset of the published bytes, so a secret in `meta.*`/`schemaVersion`/`session.{sessionId,sourceId,projectKey,updatedAt}` would survive into the committed JSONL AND pass CI) + 2 Major (M1: `projectKey` leaked the raw OS username, defeating pseudonymization; M2: CI version-parity was pinned but never actually verified) + 1 Minor. Round-1 re-review: B1 and M1 resolved and independently verified (a raw-bytes backstop scan now covers the exact serialized bytes with overlapping windows; `projectKey` is now re-derived from the already-normalized `cwd`); M2/m1 resolved but the fix introduced a new Major, M2b (strict `rulesetVersion` parity would fail every legitimate contribution once a community activates additive custom rules — fails safe, no leak, but breaks the documented feature). Round-2 re-review (M2b fix delta, completed by the lead after the implementer hit a spend limit mid-fix): **CLEAN** — `checkEngineParity` now compares the engine-pin fields strictly and only the baseline `rulesetVersion` segment, letting the additive `custom@...` segment differ; verified against 8 parse-edge cases, a non-tautological regression test, and an end-to-end fail-closed sidecar probe (missing sidecar → fail-closed; doctored baseline → fail; custom-only diff → pass). All 5 findings (B1, M1, M2, m1, M2b) resolved and non-author-confirmed by reviewer-publish, who authored none of the fixes.
- **Tasks:** `openspec/changes/mosga-v01-publish/tasks.md` — 24/24 complete (`- [x]`).
- **Git status:** working tree had the publisher package, templates scaffold, INCIDENT-RESPONSE.md, and root wiring diffs as untracked/modified files ahead of this commit. On branch `main`, not detached.

## Gates Re-Run (this session, real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — all 6 workspaces clean (contracts, session-readers, sanitizer, ui, daemon, publisher) under `strict`. |
| `npx vitest run` | PASS — 30 test files, **143/143 tests** green. |
| `npm run build` | PASS — contracts/session-readers/sanitizer/daemon/publisher emit ESM + `.d.ts` via tsup; `@mosga/ui` emits a Vite production bundle. |
| `templates/community-data-repo/scripts/scan-canary.mjs` (publish-specific gate) | **PASS, exit 0** — run from `templates/community-data-repo/` with `NODE_PATH` pointed at the repo-root `node_modules` (where `@mosga/publisher` is workspace-symlinked) since the template is intentionally outside the npm-workspaces `packages/*` glob. All 3 canaries caught: `aws-key.jsonl` (1 blocking finding), `github-pat.jsonl` (1 blocking finding), `meta-projectkey.jsonl` (2 blocking findings — this is the canary that specifically proves the B1 raw-bytes-backstop fix, since its planted secrets live in `meta.toolVersion`/`session.projectKey`, fields the structure-aware scanner never visits). |

## Pre-Commit Sanity Scan

- Scanned staged diff for credential/secret patterns (AWS/GitHub/Slack token prefixes, private-key headers, password/api-key/secret/token assignments), excluding the three canary fixtures under `templates/community-data-repo/tests/canary/*.jsonl` (which are intentionally-planted, obviously-fake secrets — the CI self-test fixtures required by task 5.3 — and MUST be committed for the gate self-test to function).
- Manually inspected all three canary fixtures: each is explicitly labeled `"CANARY (obviously fake, non-functional): ... — CI MUST catch this."` in its content, uses the same fake constants already verified in prior slices (`AKIAFAKEFAKEFAKE1234`, `ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789`), and `contributorAlias: "<CANARY>"`.
- Inspected `sanitizer.custom-rules.example.json` — a documented example config with a placeholder hostname pattern (`internal.example.invalid`) and a fictional codename (`Project Nightingale`), no real secrets.
- Inspected `scripts/hf-sync.mjs` — a documented no-op stub; reads `HF_TOKEN` only as a future env-var *name* in a comment, never a literal credential value; performs no live upload; exits 0 unconditionally.
- No other matches outside the canary fixtures and known-fake test constants (`FAKE_AWS_KEY`, `FAKE_GITHUB_PAT` in `_fixtures.ts`, consistent with prior slices).

## Commit Scope

Staged and committed:
- `packages/publisher/**` (dataset exporter, mandatory local pre-check with raw-bytes backstop, GitHub PR submission prep, engine-version parity check)
- `templates/community-data-repo/**` (community data-repo scaffold: README, LICENSE-DATA, `data/` layout, `.github/workflows/scan.yml`, canary fixtures, `sanitizer.custom-rules.example.json`, `scripts/scan-canary.mjs`, `scripts/scan-changed.mjs`, `scripts/hf-sync.mjs`)
- `INCIDENT-RESPONSE.md`
- Root wiring: `package.json`, `package-lock.json`
- `openspec/changes/mosga-v01-publish/**` (proposal, design, specs, tasks, review-report, auto-run.json, this ship-log)
- `openspec/changes/mosga-v01/planning-context.md` and `portfolio-run.json` (newest on-disk version included, not reverted)

Excluded: `.claude/` (already gitignored), `node_modules/`, `packages/*/dist/` (already gitignored via `dist/` pattern).

## Commit Message

```
feat(publish): dataset export + mandatory raw-bytes pre-check + community-repo CI template + incident response (mosga-v01-publish)

Slice 4 (final) of the mosga-v01 portfolio: @mosga/publisher exports
a stamped SanitizedSession to a deterministic JSONL path with a
version-stamped provenance sidecar, then runs a MANDATORY local
pre-check before any PR is prepared — the pre-check now scans both
the structure-aware fields AND a raw-bytes backstop pass over the
exact serialized bytes in overlapping windows, so a blocking secret
in any field (including meta.*/schemaVersion/session identifiers the
structure-aware scanner doesn't visit) refuses publication with zero
output. projectKey is re-derived from the already-normalized cwd so
pseudonymization can't be bypassed by an unscanned path field. PR
submission stages a branch/commit locally (or emits exact gh/git
commands when gh is absent) and never opens a live external PR.
The community-data-repo template provides a CI workflow that
re-scans changed records with the pinned engine, verifies
contributor/CI engine-version parity (strict on the engine pin,
baseline-only on rulesetVersion so additive custom rules don't break
parity), and fails closed on a missing provenance sidecar. A canary
self-test (3 fixtures, including one exercising the raw-bytes
backstop) proves the gate is alive on every CI run.
INCIDENT-RESPONSE.md covers HF removal/re-release, git history
rewrite, credential rotation, public incident record, and prevention
follow-up.

Verified: npm run typecheck (0 errors, strict, 6 workspaces), npx
vitest run (30 files / 143 tests green), npm run build (ESM + d.ts
for 5 packages, Vite bundle for ui), and the community-repo
canary self-test (scan-canary.mjs, exit 0, all 3 canaries caught).
Review went through 3 rounds: round 0 found 1 Blocker (pre-check
scanned a strict subset of published bytes) + 2 Major + 1 Minor;
round 1 resolved the Blocker and one Major but introduced a new
Major (M2b: strict version parity would break the additive
custom-rules feature); round 2 (M2b fix, completed by the lead after
the implementer hit a spend limit) is independently re-verified
CLEAN by a reviewer who authored none of the fixes — all 5 findings
resolved, no new issues beyond one cosmetic log-wording Trivial.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## Next Steps (not done in this run)

- Archive: to be performed as a follow-up unit in this same session (per instruction), via `/opsx:archive mosga-v01-publish`, then update `portfolio-run.json`'s `mosga-v01-publish` child to `status: "done"` with shipped+archived commit hashes and set `frontier` to `[]`, closing the v0.1 portfolio.
