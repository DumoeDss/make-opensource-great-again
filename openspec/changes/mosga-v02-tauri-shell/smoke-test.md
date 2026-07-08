# Human smoke test — mosga-v02-tauri-shell

These steps exercise GUI behavior an agent cannot verify headlessly (window
lifecycle, adopt-vs-spawn, kill-on-close, foreign-port failure). Run them on a
Windows machine with the Rust toolchain + WebView2 present. The automated
coverage (Rust unit/integration tests + `cargo build` + a full `tauri build`
producing the NSIS installer) is already green; this is the interactive gate.

## Build / launch

There are two ways to launch the shell:

- **Dev**: from `apps/desktop/`, run `npm run dev`. This builds `@mosga/daemon`
  first (so the dev-default entry `packages/daemon/dist/cli.js` exists), then
  `tauri dev`. The shell resolves the daemon from the repo checkout.
- **Installer**: run `npm run build:shell` from the repo root, then install and
  launch `mosga_<version>_x64-setup.exe` from
  `apps/desktop/src-tauri/target/release/bundle/nsis/`. (Note: this slice does
  not yet stage a bundled daemon runtime into the installer's resources, so the
  installed shell resolves the daemon via `MOSGA_DAEMON_ENTRY` or a repo
  checkout. Set `MOSGA_DAEMON_ENTRY` to an absolute `dist/cli.js` path if running
  the installed app away from the repo.)

Prerequisite for every scenario: build the JS packages once from the repo root
with `npm run build` so `packages/daemon/dist/cli.js` and `@mosga/ui`'s `dist`
exist.

## Scenarios

- [ ] **8.1 Spawn → running → usable review (fresh start).**
  With nothing listening on `127.0.0.1:8899`, launch the shell.
  - Expect the splash to appear immediately showing "Starting the mosga
    daemon…" (spawning), then transition to loading the UI.
  - The webview loads the daemon-served `http://127.0.0.1:8899/ui/`.
  - Run a review end-to-end: enumerate findings, use batch replace, preview a
    non-text (image) item, and complete an 出口② (direct-submit) consent + submit
    flow. All should work exactly as in the `npx mosga ui` browser flow.

- [ ] **8.2 Close window → spawned daemon exits (no orphan).**
  From the running-spawned state (8.1), close the shell window.
  - Confirm no `node` daemon process survives: re-probe
    `http://127.0.0.1:8899/api/health` (should refuse), or check Task Manager /
    `Get-Process node`. The spawned daemon must be tree-killed on exit.

- [ ] **8.3 Adopt an already-running daemon; do NOT kill it on close.**
  In a terminal run `npx mosga ui` (opens a browser tab). Then launch the shell.
  - Expect the shell to ADOPT the running daemon: no second daemon starts, the
    existing browser tab is untouched, the splash shows "Connected to a running
    mosga daemon…" and loads `/ui`.
  - Close the shell window. The adopted daemon MUST keep running (the browser
    tab still works; `/api/health` still answers). Only then stop it manually.

- [ ] **8.4 Foreign process on the port → clear failure.**
  Occupy `127.0.0.1:8899` with a non-mosga server (e.g.
  `npx http-server -p 8899` or `python -m http.server 8899 --bind 127.0.0.1`).
  Launch the shell.
  - Expect the splash to show "Could not start the mosga daemon." with the
    reason "port 8899 is held by a process that is not a mosga daemon — stop it
    and relaunch". The shell must NOT adopt or kill the foreign process, and must
    NOT spawn a second daemon.

## Notes for the operator

- The shell holds no API keys/secrets; provider keys remain the
  daemon/`@mosga/direct-submit` env/local-config concern.
- If a system HTTP proxy (e.g. Clash on `127.0.0.1:7890`) is active, the probe
  still works: the probe client is built `.no_proxy()` and the shell also appends
  loopback hosts to `NO_PROXY`. If adoption ever fails with a proxy up, that is
  the regression to report.
- A second shell instance simply adopts the first's daemon (single-user, fixed
  port 8899 by design) — this is expected, not a bug.
