## Why

The design doc calls the GUI a real requirement: the human-confirmation gate (finding enumeration, batch replace, per-item non-text preview, and now 出口② consent) is unusable in a terminal, and the plan always intended a Tauri v2 desktop shell after the exits stabilized (deferred from v0.1). With slice-2 shipped, the daemon endpoint set is now stable (`/api/providers`, `/api/reviews/:id/submit(/estimate)` added), so the final v0.2 slice wraps the existing `@mosga/daemon` + `@mosga/ui` in a Tauri v2 desktop app.

The shell adds no new product surface: it packages what already works over loopback HTTP into a double-click desktop app, following omnicross's proven **adopt-or-spawn daemon** pattern (read-only MIT reference). It must not widen the attack surface — the daemon stays loopback-only, no remote content, no new key/secret paths.

**Toolchain probe (design-doc gate, done first):** the Windows Rust/Tauri build chain is present and functional on this machine — `rustc`/`cargo` 1.88.0, `rustup` 1.28.2, `x86_64-pc-windows-msvc` target installed, MSVC linker verified by a real trivial-binary link, WebView2 runtime 134.x installed, Node 24. Only the Tauri CLI (`@tauri-apps/cli`) is missing, a normal dev-dependency install, not a blocker. **No escalation needed.**

## What Changes

- **New app `apps/desktop/`** (`mosga-desktop`, private) — a Tauri v2 shell: a Rust `src-tauri/` crate implementing adopt-or-spawn daemon lifecycle, a tiny bundled splash frontend showing daemon status, `tauri.conf.json`, and a `package.json` with the `@tauri-apps/cli` dev-dependency. Modeled on `omnicross/apps/desktop`.
- **Adopt-or-spawn lifecycle** (Rust state machine `probing → adopted | spawning → running | failed`, polled by the splash via a `daemon_status` command): probe `127.0.0.1:8899/api/health`; if it identifies as `mosga-daemon` → **ADOPT** (never kill it); if a foreign process holds the port → **FAIL** with a clear reason (never adopt/kill what we can't identify); else **SPAWN** our own tracked child. **mosga-specific divergence from omnicross**: because the daemon is stateful (in-memory reviews + per-reviewId `PseudonymMapper`) and this is a single-user tool, the shell *adopts any* mosga daemon rather than version-killing it, and only ever tree-kills a daemon **it spawned** — destroying in-flight review/pseudonym state is worse than a version skew for a local tool.
- **Webview strategy**: bundle a tiny splash as `frontendDist`; once the daemon is `running`, navigate the single main webview to the daemon-served `http://127.0.0.1:8899/ui/`. This reuses the exact same-origin SPA the `npx` browser flow uses — **zero UI changes, zero CORS, no duplicate asset pipeline** (the UI is built once by `@mosga/ui`; the daemon serves it; the shell just points at it). The splash resolves the startup chicken-and-egg (render immediately, show spawn/failed state before the daemon answers).
- **Daemon CLI: add a `--no-open` start** (MODIFIED `review-daemon`) so the shell can spawn the daemon without the CLI launching the OS browser (`mosga ui` currently always opens a browser). This is the only daemon code change; loopback-only binding is reaffirmed.
- **Security posture**: daemon stays `127.0.0.1`-only with its existing Host-allowlist/DNS-rebinding guard; CSP restricts the webview to `self` + the loopback daemon only (no remote hosts, no `dangerousRemoteDomainIpcAccess`); the shell introduces no key/secret handling (keys remain the daemon/direct-submit's env/local-config concern).
- **Build stays opt-in**: a separate `build:shell` script (`tauri build`) — NOT wired into the root `build`/`typecheck`/`test`. Machines without Rust keep all existing gates green; only shell builders need Rust + the Tauri CLI. `apps/*` is added to workspaces so `npm install` wires the Tauri CLI, but the aggregate scripts (explicit per-package `-w` lists) and `vitest run` are unaffected.

## Capabilities

### New Capabilities

- `desktop-shell`: the Tauri v2 desktop app wrapping the daemon + UI — adopt-or-spawn lifecycle with an identity-checked probe, spawned-only shutdown, the splash-then-daemon-`/ui` webview strategy, the loopback-only + CSP security posture, and the opt-in build that does not gate Rust-less CI.

### Modified Capabilities

- `review-daemon`: the CLI gains a no-open/headless start so the shell spawns the daemon without opening the OS browser.

## Impact

- **New app dir**: `apps/desktop/` (Rust crate + splash + Tauri config). Root `workspaces` gains `apps/*`; a new opt-in `build:shell` script.
- **New dev tooling (opt-in)**: `@tauri-apps/cli@^2`; Rust toolchain + WebView2 (build/run only). No new runtime npm dependencies for the existing packages.
- **One daemon change**: a `--no-open` CLI flag; no change to the daemon's HTTP surface, ports, or security model.
- **CI/gates**: unchanged and still runnable without Rust — the shell build is separate. Rust unit tests (`cargo test`) cover the adopt-or-spawn classification; a full `tauri build` and interactive behavior need a human smoke test (see tasks).
- **Out of scope**: any new endpoint or product feature; auth/multi-user/remote; auto-update; code-signing/notarization; cross-compiling for macOS/Linux (Windows shell only this slice; the Rust is written cross-platform-clean but only Windows is built/tested here).
