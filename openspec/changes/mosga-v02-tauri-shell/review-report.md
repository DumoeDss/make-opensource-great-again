# Review report — mosga-v02-tauri-shell

**Reviewer:** rev-v02-s3 (did not author this code)
**Date:** 2026-07-09
**Scope:** uncommitted working-tree diff + untracked `apps/desktop/`, `packages/daemon/src/cli.ts` (+test), root `package.json`/`package-lock.json`, change docs.
**Engine:** `openspec-gstack-review` (Standards + Spec axes). Adversarial subagent/Codex passes skipped per lead instruction ("no subagents").

## VERDICT: APPROVE WITH FOLLOW-UPS — no Blockers, no Majors in the reviewed shell logic. 1 Major (daemon-CLI portability), 2 Minor, 2 Trivial.

The load-bearing safety property (the shell only ever tree-kills a daemon it spawned itself) is implemented correctly on every exit path I traced. Security posture matches the design. Rust tests (8) and the new daemon CLI tests (2) pass on this machine.

---

## Verification performed (evidence)

- `cargo test` (src-tauri, warm target dir): **8 passed, 0 failed** — classify (mosga/no-version/foreign), `strip_verbatim`, `resolve_from_env` precedence, `dev_entry_path`, refused→NoListener, stub-listener adoption.
- `npx vitest run packages/daemon/src/__tests__/cli.test.ts`: **2 passed** — `--no-open` serves without opener; default start calls opener once at `/ui`.
- Confirmed the daemon actually emits the identity the probe checks: `packages/daemon/src/app.ts:153` `/api/health` → `{ name: 'mosga-daemon', version: '0.1.0' }`. Probe classifier keys on `name === "mosga-daemon"` (`daemon_runtime.rs:137-146`) — real match, not a tautology.
- Confirmed the daemon bin is `mosga → dist/cli.js` (`packages/daemon/package.json`) — relevant to the Major below.

---

## Focus-area findings

### 1. Process-kill safety (Blocker class) — CLEAN

Every exit/close/error path traced; none can kill a process the shell did not spawn:

- `kill_tree(pid)` takes the **spawned child PID** (`kill.rs:15`, called with `child.id()`), never a port-based kill. `taskkill /PID <pid> /T /F` is PID-rooted.
- `DaemonRuntime::shutdown()` (`daemon_runtime.rs:107-118`) early-returns when `!spawned`; `spawned` is set `true` **only** on the wait-for-port success path (`daemon_runtime.rs:355-356`). Adopted daemon → `spawned` stays `false` → shutdown no-ops. Verified.
- Adopt path (`daemon_runtime.rs:309-312`) sets `running(true)` and returns without ever creating a `Child` → nothing to kill.
- Foreign path (`daemon_runtime.rs:313-319`) sets `failed` and returns — never adopts, never kills. Matches spec scenario.
- Timeout kill (`daemon_runtime.rs:363`) and early-exit path (`daemon_runtime.rs:345-349`) both operate on the local `child` the shell itself spawned. Correct.
- Exit hook (`lib.rs:75-77`) fires `shutdown()` on `ExitRequested | Exit`; `shutdown()` is idempotent (clears `child`/`spawned`), so the double-fire is harmless.

### 2. Adopt/spawn correctness — CLEAN

- Probe client built `.no_proxy()` (`daemon_runtime.rs:156-159`) + belt-and-suspenders `NO_PROXY` merge in `lib.rs:26-42` (runs before any reqwest build). Correct — a loopback daemon behind a system proxy is not misclassified as absent.
- Identity from `/api/health` body, any version adopted (`classify_health` returns `Mosga` for any version incl. missing → `""`; `adopt_or_spawn` matches `Mosga { .. }`). Matches the deliberate no-version-kill divergence.
- Spawn args verified: `node <entry> ui --no-open --port 8899` (`daemon_runtime.rs:257-263`), `CREATE_NO_WINDOW` on Windows (`:268-273`), stderr piped for failure reason.
- `strip_verbatim` applied to the canonicalized dev/bundled path (`:217`, `:235`); unit-tested for `\\?\` and `\\?\UNC\`. Correct EISDIR mitigation.
- Non-JSON / slow foreign servers: a body that fails JSON parse → `classify_health(None)` → `Foreign`; a foreign server slower than the 700ms probe → `NoListener` → spawn → daemon hits `EADDRINUSE`, its own adopt-probe finds non-mosga, exits non-zero → captured as `failed` via stderr tail. Both terminate safely without killing the foreign process.

### 3. Security posture — CLEAN

- CSP (`tauri.conf.json:25`): `default-src 'self'`; `connect-src` limited to `self` + `ipc:`/`http://ipc.localhost` + `http://127.0.0.1:8899`; `script-src 'self'`. **No remote hosts.** No `dangerousRemoteDomainIpcAccess`.
- IPC surface = exactly one command, `daemon_status` (`lib.rs:52`), which returns only lifecycle status (state/reason/port/adopted) — no secrets, no side effects. The loopback `/ui` origin cannot reach it (no remote-IPC grant; capabilities scoped to `["main"]`, `core:default` only). Justified and minimal.
- Shell handles no keys/secrets (confirmed across all Rust — nothing reads env keys or config beyond `MOSGA_DAEMON_ENTRY`/`NO_PROXY`).

### 4. Daemon change minimality — CLEAN (default behavior preserved), see Major #1

- Behavioral change is limited to the `--no-open` branch; the default path still calls `open(...)` once at `/ui` (`cli.ts:136-139`), asserted by the new test. Loopback-only bind unchanged.
- The `main()`→exported `run(argv, deps)` refactor is broader than a one-line flag but is justified (injectable opener/stdout for the test). See Major #1 for the one risk it introduces.

### 5. CI isolation — CLEAN

- Root `build`/`typecheck` remain explicit per-package `-w` lists excluding `apps/desktop`; `test` is still `vitest run` (`package.json`). `build:shell`/`check:shell` are the only Rust/Tauri entry points and are opt-in. Adding `apps/*` to workspaces pulls only a Node devDep (`@tauri-apps/cli`), no Rust. Rust-less CI stays green.

### 6. Splash → navigate flow — CLEAN (GUI portion deferred to smoke test)

- Splash polls `daemon_status` every 300ms; `running` → `window.location.replace('http://127.0.0.1:8899/ui/')`; `failed` → stop polling, show `reason`; IPC error → transient "Waiting for the desktop shell…" and retry (`splash/main.js`). Failure reasons (foreign port, spawn error, timeout) are all human-readable strings set in `daemon_runtime.rs`. Actual navigation is a GUI behavior only the human smoke test can confirm — appropriately listed in `smoke-test.md` 8.1.

### 7. Rust test honesty — CLEAN

All 8 tests assert real logic against real inputs (JSON bodies, path prefixes, env-file existence, a live ephemeral stub listener for the adoption path). No tautologies. The stub-listener test reads the request before responding to avoid a Windows RST misread — a real correctness detail, not padding.

### 8. Scope hygiene — CLEAN

No archived change touched (only `mosga-v02/planning-context.md` slice-3 addendum + the new change dir). `smoke-test.md` has all four scenarios (spawn lifecycle, close-kills-spawned-only, adopt-running, foreign-port) with accurate expected behavior.

---

## Findings by severity

### MAJOR

**M1 — `cli.ts:167-170` auto-run guard is not symlink-safe; `mosga ui` can silently no-op on macOS/Linux.**
The new guard `import.meta.url === pathToFileURL(process.argv[1]).href` compares against the **raw** `process.argv[1]`. Node resolves `import.meta.url` to the file's realpath, but `process.argv[1]` is the path as invoked. On platforms where the npm bin (`mosga → dist/cli.js`) is a **symlink** (`node_modules/.bin` on macOS/Linux), the two differ → the guard is false → `run()` never executes → `mosga ui` / `npx mosga ui` does nothing. This is a regression of the standalone daemon's public entry point (the previous code ran `void main()` unconditionally).

Scope/uncertainty (stated honestly): the **desktop shell is unaffected** — it spawns `node <resolved-path> …` directly (`resolve_daemon_command` returns a canonicalized realpath as argv[1]), so the guard matches. On **Windows** (this machine, the tested platform) npm uses a `.cmd` shim that passes the resolved cli.js path, so it also matches — verified conceptually and consistent with the passing tests. I could not execute a macOS/Linux symlinked-bin invocation here to prove the break; the conclusion rests on documented Node behavior (`--preserve-symlinks-main` defaults off → realpath entry identity).

Fix (cheap hardening): resolve the invoked path before comparing —
```ts
import { realpathSync } from 'node:fs';
const invoked = process.argv[1];
if (invoked && pathToFileURL(realpathSync(invoked)).href === import.meta.url) {
  void run(process.argv.slice(2));
}
```

### MINOR

**m1 — Orphan-during-spawn window (`daemon_runtime.rs:342-358`, `lib.rs:75-77`).**
If the shell exits while `adopt_or_spawn` is still inside the bounded wait-for-port loop (before line 355 hands the `Child` to the managed handle and sets `spawned=true`), `shutdown()` sees `spawned==false` and no-ops, leaving the spawned `node` daemon orphaned. Kill-**safety** is intact (it can never kill a non-spawned process), but the spec's "spawned daemon dies with the shell / no orphan" guarantee has a hole for up to ~10s (`WAIT_ATTEMPTS*WAIT_INTERVAL`). Impact is bounded: the next launch adopts the orphan (it is a mosga daemon). Consider registering the `Child` in the managed handle immediately after `spawn()` (before the wait loop) so an early exit still tree-kills it.

**m2 — CSP `style-src 'unsafe-inline'` (`tauri.conf.json:25`).**
Needed only because the splash inlines its `<style>`. Low risk (bundled `tauri://` origin, no user-controlled content), but could be tightened by externalizing the splash stylesheet if a stricter posture is wanted. Not blocking.

### TRIVIAL

**t1 — Documented `adopted` state is never emitted as a distinct `state` string.** `design.md:28` and `splash/main.js` `LABELS.adopted` imply an `adopted` state, but the Rust collapses adoption into `state:"running", adopted:true` (`daemon_runtime.rs:310`). The splash renders it correctly via the `adopted` flag, so behavior is right; the state-machine doc and label map just don't line up 1:1. Cosmetic.

**t2 — `resolve_from_env` returns the raw env path un-stripped** (`daemon_runtime.rs:189`). Fine for a normal user-supplied path; only relevant if someone sets `MOSGA_DAEMON_ENTRY` to a `\\?\` verbatim path, which is unlikely. No action needed.

---

## Spec axis summary

Every ADDED requirement in `specs/desktop-shell/spec.md` (adopt-or-spawn + identity probe, spawned-only shutdown, splash-then-`/ui` webview, loopback-only/no-remote CSP, Rust-less CI) and `specs/review-daemon/spec.md` (`--no-open`) is implemented in the diff. No scope creep observed. The two human-only scenarios (GUI lifecycle) are correctly left to `smoke-test.md`; `tasks.md` 8.1-8.4 remain unchecked as intended.

**Per-axis worst issue:** Standards — M1 (portability of the CLI guard). Spec — none (all requirements met; GUI verification deferred by design).

---

## Round 2 (delta re-review) — 2026-07-09

Re-reviewed ONLY the fix delta for the round-1 findings. Verified independently: `cargo test` **10/10 pass** (warm target dir); daemon CLI tests pass (lead-verified vitest 189/189).

### M1 — RESOLVED
`cli.ts` extracts an exported, testable `isEntrypoint(importMetaUrl, argv1)` (`cli.ts:171-185`):
- Resolves `argv1` through `realpathSync` **before** the `pathToFileURL(...).href` compare, so a symlinked npm bin (macOS/Linux) now matches the realpath-resolved `import.meta.url`. The exact regression I flagged is closed.
- `try/catch` falls back to the raw path when `argv1` can't be resolved (nonexistent), and returns `false` when `argv1` is undefined (imported, not launched) — the test-import case stays a no-op.
- Genuinely unit-tested, not a tautology (`cli.test.ts:11-68`): creates a **real symlink** to a stub file and asserts `isEntrypoint(url, link) === true` (with a Windows case-fold fallback), and asserts a wrong path returns `false`. It also pre-`realpathSync`es the tmpdir so macOS `/var`→`/private/var` symlinks don't confound the assertion — a real correctness detail.
- Default (non-symlink) behavior unchanged: a real `argv1` realpath-resolves to itself and matches.

### m1 — RESOLVED, no new exit-path regressions
`register_spawned()` (`daemon_runtime.rs:110-115`) marks the child as ours (`spawned=true`, `child=Some`, status `spawning`) **immediately after `spawn()` returns, before the wait loop** (`:354`). The orphan window (previously ~10s) is closed to a few instructions between spawn-return and register — effectively gone. Traced the reworked paths for the invariant and for races:
- **Kill-safety invariant intact:** adopt (`:320-322`) and foreign (`:324-329`) still return without registering a child or setting `spawned`, so `shutdown()` no-ops for them. New test `shutdown_is_noop_when_not_spawned` asserts an adopted daemon survives shutdown.
- **No double-kill / no kill-before-spawn race:** the wait loop re-acquires the lock each iteration and bails if `guard.child` is `None` (shutdown reaped it while the shell was closing, `:363-365`); the timeout (`:390-401`) and early-exit (`:368-375`) paths kill/reap through the managed handle and clear `child`/`spawned`, so a concurrent `shutdown()` sees `None` and no-ops. `shutdown()` remains idempotent.
- **Promote-to-running keeps ownership:** on success it only sets status `running(false)` if the child is still owned (`:380-382`), leaving `spawned=true` so exit still tree-kills — matching "spawned daemon dies with the shell."
- Honestly tested: `registered_child_is_killed_by_shutdown` spawns a real `node` sleeper, registers it, and asserts `shutdown()` clears the handle (skips if `node` is absent rather than failing).

### m2 — RESOLVED (fixed, not just accepted)
CSP tightened to `style-src 'self'` (dropped `'unsafe-inline'`, `tauri.conf.json:25`) AND the splash's inline `<style>` was externalized to `splash/style.css`, linked same-origin via `<link rel="stylesheet" href="style.css">` (`splash/index.html:7`). No residual inline `<style>`/`style=` remains, and `main.js` mutates only `classList`/`textContent` (no inline-style injection), so the tighter CSP won't blank the splash or break it at runtime. Internally consistent.

### Trivials t1/t2
Not addressed — cosmetic, as noted; no action expected.

### ROUND 2 VERDICT: CLEAN
All three actionable findings (M1 Major, m1 Minor, m2 Minor) are genuinely resolved with honest, non-tautological test coverage; the kill-safety invariant I traced in round 1 is preserved and the fix delta introduces no new exit-path regressions. Nothing remains blocking. Ready to archive (pending the human GUI smoke test, which is out of agent scope by design).
