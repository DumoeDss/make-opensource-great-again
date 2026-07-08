# Design — mosga-v02-tauri-shell

## Toolchain probe (design-doc gate — run FIRST, result recorded)

Probed on this Windows machine:

| Tool | Result |
| --- | --- |
| `rustc` / `cargo` | 1.88.0 — present |
| `rustup` | 1.28.2; target `x86_64-pc-windows-msvc` installed |
| MSVC linker | **functional** — a trivial `cargo build` compiled AND linked (cargo discovers the linker via vswhere; the Git `link.exe` on PATH is irrelevant) |
| WebView2 runtime | installed, `pv 134.0.3124.93` (Tauri's Windows webview dependency) |
| Node | v24.14.0 |
| Tauri CLI | **not installed** — `@tauri-apps/cli` is a normal `npm i -D`, not a blocker |

**Verdict: buildable. No escalation.** The only setup step is installing the Tauri CLI dev-dependency.

## Context

The daemon (`@mosga/daemon`) binds `127.0.0.1:8899` (loopback-only, Host-allowlist + DNS-rebinding guard, no auth — single-user threat model), self-serves the built `@mosga/ui` SPA at `/ui`, and is **stateful**: `POST /api/reviews` holds `{ session, report, mapper }` per `reviewId` in memory (the `PseudonymMapper` cannot round-trip to the browser). Its CLI is `mosga ui [--port N]` (bin `mosga` → `dist/cli.js`), which starts the daemon and **always opens the OS browser**, with an existing trimmed "adopt ours (`/api/health` `name==='mosga-daemon'`) else fail" negotiation.

This slice wraps that daemon + UI in a Tauri v2 desktop shell, adapting omnicross's `apps/desktop` adopt-or-spawn module (`src-tauri/src/daemon_runtime.rs`, read-only MIT).

## Adopt-or-spawn lifecycle

A Rust state machine (Tauri-managed, exposed via a `daemon_status` command the splash polls) mirroring omnicross:

```
probing → { adopted | spawning → running | failed }
```

1. **Probe** `http://127.0.0.1:8899/api/health` with a blocking client built `.no_proxy()` (load-bearing — a system `HTTP_PROXY` like Clash on 127.0.0.1 would 502 the loopback probe and make a live daemon look absent), short timeout. Classify:
   - **NoListener** (refused/timeout) → SPAWN.
   - **Mosga daemon** (`200` body `{ name: 'mosga-daemon', version }`) → **ADOPT** (state `adopted`/`running`, `adopted:true`).
   - **Foreign** (answers but not a mosga daemon) → **FAIL** with a clear reason ("port 8899 held by a non-mosga process — stop it and relaunch"). Never adopt, never kill what we can't identify.
2. **Spawn** (NoListener only): resolve the daemon entry (env override `MOSGA_DAEMON_ENTRY` → bundled runtime under the resource dir for packaged installs → dev default `packages/daemon/dist/cli.js` anchored on `CARGO_MANIFEST_DIR`), then run `node <entry> ui --no-open --port 8899` as a tracked child (Windows `CREATE_NO_WINDOW`; stderr piped for a failure reason; `strip_verbatim` the canonicalized Windows path so Node doesn't choke on the `\\?\` prefix — an omnicross-proven gotcha).
3. **Wait for port**: bounded re-probe; first success → `running` (`adopted:false`, child handed to the managed handle for kill-on-exit). Child exits early → `failed` with its stderr tail. Timeout → `failed` + tree-kill the child.

### mosga-specific divergence from omnicross (deliberate)

omnicross **kills** a stale/version-mismatched daemon and respawns. mosga does **not**: the daemon holds in-memory review + pseudonym state, and this is a single local user. So:

- **Adopt any mosga daemon** regardless of version (no version-kill). A brief version skew between a running daemon and a newer shell is strictly better than destroying an in-flight review the user is part-way through dispositioning.
- **Only ever tree-kill a daemon this shell spawned.** An adopted daemon (e.g. one started by `npx mosga ui`, or another shell) is never killed.

This needs no pid handshake (we never kill by pid), so the existing `/api/health` body identity suffices — no daemon header change.

### Port handling

Fixed `8899` (the daemon default), matching the probe URL. Dynamic ports would require a portfile handshake; unjustified for a single-user loopback tool. Consequence: a second shell instance simply adopts the first's daemon (fine for single-user). Documented.

### Shutdown policy

- **Spawned daemon** → tree-killed on shell exit (Windows tree-kill by pid; the child is stdio-detached). In-memory review state is lost on close — acceptable and already documented (a re-scan is deterministic; `Finding.id` is stable).
- **Adopted daemon** → never killed (it outlives the shell, as its owner expects).

## Webview strategy (bundle splash, then daemon `/ui`)

Chosen: **a tiny bundled splash as `frontendDist`; on `running`, navigate the single main webview to `http://127.0.0.1:8899/ui/`.**

- The `@mosga/ui` SPA is same-origin by design (it is served by the daemon and calls `/api/...` relatively). Pointing the webview at the daemon's `/ui` reuses it **verbatim — zero UI changes, zero CORS**, and preserves the daemon's "same-origin, zero-CORS" property.
- **No duplicate asset pipeline**: the UI is built once (`@mosga/ui` → `dist`); the daemon already serves that `dist`; the shell only bundles a few-KB splash, not a second copy of the SPA.
- The splash resolves the **startup chicken-and-egg**: a webview pointed straight at the daemon URL would render blank while the daemon spawns. The splash renders instantly (`tauri://`), polls `daemon_status`, shows `spawning`/`failed` reasons, and navigates to `/ui` only once `running`.
- Once on `/ui` (loopback http origin), Tauri IPC is not available (different origin) — fine: `/ui` uses HTTP to the same-origin daemon, not IPC. If the daemon dies mid-session, `/ui` shows fetch errors exactly as the browser flow does.

### Alternative considered: bundle the full `ui/dist`, call the daemon cross-origin

omnicross does this (`frontendDist = packages/ui/dist`, `connect-src` allows the daemon). Rejected for mosga: it would force the SPA to use a configurable absolute API base **and** require the daemon to emit CORS headers for the `tauri://localhost` origin — widening the daemon's deliberate zero-CORS/same-origin posture. The splash-then-`/ui` approach keeps that posture intact for a few KB of splash.

## Security posture

- Daemon unchanged: `127.0.0.1`-only bind, Host-allowlist + DNS-rebinding guard, no auth (single-user model, already documented).
- CSP (`tauri.conf.json`): `default-src 'self'`; `connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:8899`; `navigate-to`/`default-src` permit the loopback `/ui` only. **No remote hosts.** No `dangerousRemoteDomainIpcAccess`.
- The only non-`tauri://` origin ever loaded is our own loopback daemon at the fixed port — not remote content.
- The shell adds **no** key/secret handling: provider keys remain the daemon/`@mosga/direct-submit` env/local-config concern; the shell never reads, stores, or forwards them.

## Package / workspace layout

```
apps/desktop/
  package.json          # private "mosga-desktop"; devDep @tauri-apps/cli@^2; scripts: dev, build (tauri build)
  splash/               # tiny bundled frontend (index.html + minimal TS): daemon-status poll + navigate
  src-tauri/
    Cargo.toml          # tauri v2, reqwest(blocking, no_proxy), serde/serde_json
    tauri.conf.json     # frontendDist -> splash build; CSP; bundle resources (packaged: staged daemon runtime)
    build.rs
    src/{lib.rs, daemon_runtime.rs, kill.rs}
```

- **Workspaces**: add `apps/*` to root `workspaces` so `npm install` wires `@tauri-apps/cli`. The aggregate `build`/`typecheck` are explicit per-package `-w` lists that do **not** include the app, and `test` is `vitest run` (Rust tests are `cargo test`) — so **Rust-less CI stays green**.
- **tsconfig**: the splash, if it uses TS, follows the repo's `noEmit` typecheck-only convention (Vite/Tauri emits the bundle). Keep the splash minimal to avoid a heavy toolchain.
- **Rust testing**: `cargo test` unit-tests the pure logic — probe classification (NoListener/Mosga/Foreign from a fake response), daemon-command resolution precedence, and `strip_verbatim`. The HTTP probe and spawn are integration-tested against a stub HTTP listener where feasible.

## CI / build implications

- Existing gates (`npm run build`, `npm run typecheck`, `npm test`) are unchanged and require **no** Rust.
- New opt-in `build:shell` (root) → `npm --prefix apps/desktop run build` → `tauri build`. Only run by someone building the installer.
- A `check:shell` convenience (`cargo check`/`cargo test` in `src-tauri`) is the automatable Rust gate.

## What is testable headlessly on THIS machine vs needs a human

**Headless (automatable here):**
- `cargo test` — adopt-or-spawn classification, command resolution, `strip_verbatim` (verified cargo works).
- `cargo check` / `cargo build` of the `src-tauri` crate (pulls the Tauri/WebView2 crates; should compile given MSVC + WebView2 present).

**Attempt, may need network/bundler downloads:**
- `tauri build` (NSIS installer) — Tauri may fetch the NSIS bundler / WebView2 bootstrapper on first run; mark as attempt-and-report.

**Human smoke test (GUI — cannot be verified headlessly by an agent):**
- Launch → see `spawning` then `running`; the daemon `/ui` loads.
- Run a full review (findings, batch, non-text) and an 出口② submit through the shell.
- Close the window → the spawned daemon process dies (no orphan).
- Launch while `npx mosga ui` is already running → the shell **adopts** it (no second daemon, its browser tab untouched); closing the shell does **not** kill the adopted daemon.
- Occupy 8899 with a non-mosga server → shell shows the `failed` foreign-port reason.

## Risks

- **`tauri build` may need first-run downloads** (NSIS/WebView2 bootstrapper) — mitigated by making the build opt-in and reporting rather than gating.
- **Spawned-daemon state loss on close** — acceptable and documented (deterministic re-scan).
- **Adopt-any-version could pair a new shell with an old daemon** — accepted trade-off for a stateful single-user tool; the shell surfaces the adopted daemon's version so a mismatch is visible.
- **GUI unverifiable by the agent** — explicit human smoke-test checklist in tasks; automatable coverage is the Rust unit tests + `cargo build`.
