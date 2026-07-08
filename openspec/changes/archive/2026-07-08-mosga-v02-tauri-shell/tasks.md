# Tasks — mosga-v02-tauri-shell

## 1. Toolchain probe (design-doc gate — DONE in proposal)

- [x] 1.1 Probe Rust/Cargo/Tauri/MSVC/WebView2/Node. **Result: buildable** (rustc/cargo 1.88.0, msvc target + linker verified, WebView2 134.x, Node 24; only `@tauri-apps/cli` to install). No escalation. Recorded in design.md.

## 2. Daemon CLI: no-open start (MODIFIED review-daemon)

- [x] 2.1 Add a `--no-open` flag to `mosga ui` (`packages/daemon/src/cli.ts`) that starts the daemon without calling `openBrowser`. Keep default behavior (open browser) unchanged; reaffirm loopback-only bind. Add a vitest case that `--no-open` starts and serves without invoking the browser opener (inject/spy the opener).

## 3. App scaffold

- [x] 3.1 Create `apps/desktop/` with `package.json` (private `mosga-desktop`, devDep `@tauri-apps/cli@^2`, scripts `dev`/`build`), a minimal `splash/` frontend, and `src-tauri/` (Cargo.toml for Tauri v2 + `reqwest` blocking with `no_proxy` + serde/serde_json, `tauri.conf.json`, `build.rs`, `src/`). Model on `omnicross/apps/desktop`.
- [x] 3.2 Add `apps/*` to root `workspaces`. Add an opt-in root script `build:shell` (`npm --prefix apps/desktop run build`) and `check:shell` (`cargo test`/`check` in `src-tauri`). Do NOT wire either into `build`/`typecheck`/`test`.

## 4. Adopt-or-spawn lifecycle (Rust)

- [x] 4.1 `daemon_runtime.rs`: state machine `probing → adopted | spawning → running | failed`, Tauri-managed, exposed via a `daemon_status` command.
- [x] 4.2 `probe()`: blocking `reqwest` client built `.no_proxy()`, short timeout, `GET http://127.0.0.1:8899/api/health`; classify NoListener / Mosga (`body.name === 'mosga-daemon'`) / Foreign.
- [x] 4.3 Adopt policy (mosga divergence): adopt ANY mosga daemon (no version-kill); Foreign → failed with a clear reason; never adopt/kill a non-spawned process.
- [x] 4.4 `resolve_daemon_command()`: env override `MOSGA_DAEMON_ENTRY` → bundled runtime (packaged) → dev default `packages/daemon/dist/cli.js` anchored on `CARGO_MANIFEST_DIR`; `strip_verbatim` the Windows canonical path. Spawn `node <entry> ui --no-open --port 8899` as a tracked child (`CREATE_NO_WINDOW`, stderr piped).
- [x] 4.5 `wait_for_port`: bounded re-probe → running (hand child to managed handle); early child exit → failed with stderr tail; timeout → failed + tree-kill.
- [x] 4.6 `kill.rs`: Windows tree-kill by pid. Shutdown hook tree-kills ONLY a spawned child; adopted daemon untouched.

## 5. Webview strategy

- [x] 5.1 `tauri.conf.json`: `frontendDist` → the splash build; CSP `default-src 'self'`, `connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:8899`, permit navigation to the loopback `/ui` only; no remote hosts; no `dangerousRemoteDomainIpcAccess`; main window initially hidden until status resolves.
- [x] 5.2 Splash: poll `daemon_status`; render probing/spawning/failed (with reason); on `running`, navigate the main webview to `http://127.0.0.1:8899/ui/`.

## 6. Rust tests (headless, automatable here)

- [x] 6.1 `cargo test`: probe classification (NoListener/Mosga/Foreign from injected responses), `resolve_daemon_command` precedence, `strip_verbatim`.
- [x] 6.2 Where feasible, an integration test spawns a stub HTTP listener returning the mosga `/api/health` body and asserts adoption (no spawn).

## 7. Build verification (this machine)

- [x] 7.1 `cargo check` / `cargo build` the `src-tauri` crate (expected to compile: MSVC + WebView2 present). Report result.
- [x] 7.2 Attempt `tauri build` (NSIS). It may fetch the NSIS/WebView2 bootstrapper on first run — attempt and REPORT the outcome; do not treat a download requirement as a hard failure of the slice.
- [x] 7.3 Confirm `npm run build`, `npm run typecheck`, `npm test` still pass WITHOUT Rust involvement (shell excluded from aggregates).

## 8. Human smoke test (GUI — cannot be agent-verified; document for the operator)

> Checklist WRITTEN to `smoke-test.md` (build/launch instructions + the four
> scenarios below with expected behavior). The boxes stay unchecked until a human
> operator runs them on a Windows GUI session — an agent cannot verify GUI
> lifecycle. Automated coverage (Rust tests + `cargo build` + full `tauri build`)
> is green.

- [ ] 8.1 Launch the shell → observe `spawning` then `running`; the daemon `/ui` loads and a review is usable end-to-end (findings, batch, non-text, 出口② submit).
- [ ] 8.2 Close the window → the spawned daemon process exits (no orphan; verify via task list / re-probe).
- [ ] 8.3 With `npx mosga ui` already running, launch the shell → it ADOPTS (no second daemon, browser tab untouched); closing the shell does NOT kill the adopted daemon.
- [ ] 8.4 Occupy port 8899 with a non-mosga server → shell shows the failed foreign-port reason.

## 9. Validate

- [x] 9.1 `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v02-tauri-shell --json` passes.
