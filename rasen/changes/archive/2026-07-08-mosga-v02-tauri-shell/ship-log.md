# Ship Log: mosga-v02-tauri-shell

**Date:** 2026-07-09
**Mode:** Direct commit to `main` + push (solo-owner repo, serial dependent slices — no PR, no merge ceremony; matches v0.1 and prior mosga-v02 slices)
**Branch:** main
**Status:** Shipped — slice 3 (final) of the mosga-v02 portfolio (Tauri v2 desktop shell)

## Pre-Flight Results

- **Verification evidence:** `openspec/changes/mosga-v02-tauri-shell/review-report.md` — reviewer rev-v02-s3 (not the author). Round 1: **APPROVE WITH FOLLOW-UPS** — no Blockers, no Majors in the core shell safety logic (process-kill safety, adopt/spawn correctness, security posture, daemon-change minimality, CI isolation, splash→navigate flow, and Rust-test honesty were all CLEAN); 1 Major (CLI entrypoint guard symlink-fragile on POSIX), 2 Minor (small spawn-to-registration orphan window; CSP allowed `unsafe-inline` for styles), 2 cosmetic Trivials. Round 2 (delta re-review, scoped to the fix delta): **CLEAN** — all three actionable findings resolved with honest, non-tautological tests (a real symlink fixture for the entrypoint guard in `cli.test.ts`; a real spawned `node` process asserting `shutdown()` for the registration-window fix); the kill-safety invariant traced in round 1 (the shell only ever tree-kills a process it itself spawned) re-verified intact with no new exit-path regressions. Trivials left as cosmetic, no action expected. "Ready to archive (pending the human GUI smoke test, which is out of agent scope by design)."
- **Tasks:** `openspec/changes/mosga-v02-tauri-shell/tasks.md` — 18/22 subtasks marked `- [x]`. The 4 remaining (section 8, "Human smoke test — GUI, cannot be agent-verified") are intentionally left unchecked: `smoke-test.md` documents the build/launch instructions and the 4 scenarios (launch→spawning→running→`/ui` usable; close→spawned daemon exits with no orphan; adopt when `npx mosga ui` already running→no second daemon, adopted daemon survives shell close; occupied-port→foreign-listener reason shown) for a human operator to run on a Windows GUI session. This is documented, expected, and matches the review's own "ready to archive pending human smoke test" note — not a gap in agent-verifiable work.
- **Git status:** working tree had the entire new `apps/desktop/` Tauri app (splash, Rust `src-tauri` crate, icons, config), the daemon `--no-open` flag + symlink-safe entrypoint guard + its new test, root workspace wiring, the office-hours/planning-context update, and the change directory as untracked/modified ahead of this commit. On branch `main`, not detached. Confirmed `apps/desktop/src-tauri/gen/` (Tauri-generated schemas) is covered by `apps/desktop/.gitignore:5` and was correctly excluded (`git status --ignored` showed it `!!`, never staged).

## Gates Re-Run (this session, real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — all workspaces clean under `strict`. Rust-free, as required. |
| `npm run build` | PASS — all packages build clean. Rust-free. |
| `npx vitest run` | PASS — 39 test files, **189/189 tests** green (up from 184; +5, including the new `cli.test.ts` entrypoint-guard tests). Rust-free. |
| `cargo test` (in `apps/desktop/src-tauri`, `$env:CARGO_TARGET_DIR` redirected to the scratchpad off the nearly-full E: drive) | PASS — **10/10 tests** (classify mosga/no-version/foreign listener, `strip_verbatim`, `resolve_from_env` precedence, `dev_entry_path`, refused→NoListener, stub-listener adoption, `shutdown_is_noop_when_not_spawned`, `registered_child_is_killed_by_shutdown`). Warm target dir, finished in ~1.2s. Confirmed no build artifacts landed on E: (`gen/` and `target/` both gitignored and absent from `git status`). |
| `node .../rasen.js validate mosga-v02-tauri-shell --strict --json` | PASS — 1/1 items valid, 0 issues. |

## Pre-Commit Sanity Scan

- Scanned the new `packages/daemon/src/__tests__/cli.test.ts` and the Rust sources under `apps/desktop/src-tauri/src/` for hardcoded secret-like literals (AWS/GitHub/generic key prefixes, private-key headers, password/api-key/secret/token assignments) — no matches. No fake-canary constants needed in this slice (no secret-scanning surface — the entrypoint-guard test uses a real filesystem symlink to a stub file, and the Rust tests use stub HTTP listeners, not credential material).
- Confirmed `git status` before commit showed exactly the file set specified for this slice as dirty (everything, per the shipping brief — nothing excluded this time).

## Commit Scope

Staged and committed:
- `apps/desktop/**` (new Tauri v2 app: `.gitignore`, `package.json`, `splash/{index.html,main.js,style.css}`, `src-tauri/{Cargo.lock,Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,icons/*,src/{main.rs,lib.rs,daemon_runtime.rs,kill.rs}}`)
- `packages/daemon/src/cli.ts` (`--no-open` flag + symlink-safe `isEntrypoint()` guard), `packages/daemon/src/__tests__/cli.test.ts` (new)
- Root wiring: `package.json`, `package-lock.json` (adds `apps/*` to workspaces)
- `openspec/changes/mosga-v02/planning-context.md` (slice-3 findings)
- `openspec/changes/mosga-v02-tauri-shell/**` (proposal, design, specs, tasks, review-report, smoke-test.md, auto-run.json, this ship-log)

Excluded (gitignored, never staged):
- `apps/desktop/src-tauri/gen/` (Tauri-generated schema JSON, regenerated on build)
- `apps/desktop/src-tauri/target/` (Rust build output — additionally kept off the E: drive entirely via `CARGO_TARGET_DIR`)

## Commit

- **Hash:** `57ce32ffa6537aa9ec5d773be898c6053b7d78e4` (short: `57ce32f`)
- **Message:** `feat(desktop): Tauri v2 shell — adopt-or-spawn daemon lifecycle + splash-to-/ui webview (mosga-v02-tauri-shell)`
- **Pushed:** `origin/main` updated `d156365..57ce32f` (fast-forward).

## Archive

- **Archived to:** `openspec/changes/archive/2026-07-08-mosga-v02-tauri-shell/` (date is UTC-derived by `rasen archive`; local archive date was 2026-07-09 +0800).
- **Specs synced:** a new `openspec/specs/desktop-shell/spec.md` capability spec (5 requirements: adopt-or-spawn daemon lifecycle with an identity-checked probe, only a spawned daemon is shut down with the shell, webview loads the daemon-served UI behind a status splash, loopback-only/no-remote-content security posture, and the shell build does not gate Rust-less CI) and 1 requirement ADDED to `openspec/specs/review-daemon/spec.md` (a `--no-open` daemon CLI start for the shell), appended after the 12 pre-existing requirements with none altered. Totals per `rasen archive --json`: 6 added, 0 modified, 0 removed.
- **Merge verification:** manually read both merged spec files. `desktop-shell/spec.md` matches the delta's 5 requirements verbatim with a standard `Purpose: TBD` placeholder for a first-time capability spec. `review-daemon/spec.md` retains all 12 prior requirement headings unchanged and in order (`grep -c "^### Requirement"` — 13 total after this archive, up from 12 after `mosga-v02-direct-submit`), with the new "Daemon CLI supports a no-open start for the shell" requirement cleanly appended at the end.
- **Validation after archive:** `rasen validate --all --json` — 21/23 items pass; both synced specs (`desktop-shell`, `review-daemon`) pass with 0 errors, as do all 11 other pre-existing specs. The 2 failing items (`mosga-v01`, `mosga-v02` portfolio-tracking directories with no spec deltas by design) are pre-existing and unrelated to this archive. Notably `mosga-v02-tauri-shell` and its scaffold are no longer in the failure list — this was the last untracked slice of the portfolio.
- **Archive commit hash:** `c5d1b4ad69f2e69571a67dc983965e5bb5b24631` (short: `c5d1b4a`) — `chore(openspec): archive mosga-v02-tauri-shell`. The lead's uncommitted `auto-run.json` edit moved into the archive directory as-is and is included in this commit unmodified.
- **Pushed:** `origin/main` updated `738ad06..c5d1b4a`.

## Next Steps (not done in this run)

- **Human GUI smoke test:** an operator must run the 4 scenarios in `smoke-test.md` on a Windows GUI session before the desktop shell is considered field-verified end-to-end; this remains out of agent scope by design and was explicitly called out as pending by the round-2 review. This is the one open item blocking full end-to-end verification of the mosga-v02 portfolio.
- Run-state accounting (`openspec/changes/mosga-v02/portfolio-run.json` updates, marking this slice's — and the portfolio's — status `done` with the shipped+archived commit hashes) is owned by the lead, not the shipper/archiver, per instruction. This was the final slice of the mosga-v02 portfolio.
