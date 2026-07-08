## ADDED Requirements

### Requirement: Adopt-or-spawn daemon lifecycle with an identity-checked probe

The desktop shell SHALL reach a daemon on the fixed loopback port `127.0.0.1:8899` via an adopt-or-spawn state machine (`probing → adopted | spawning → running | failed`) whose status is exposed to the shell frontend. It SHALL probe `GET /api/health` (with proxies disabled so a system HTTP proxy cannot mask the loopback daemon) and classify the listener: a response identifying as `mosga-daemon` SHALL be ADOPTED; a listener that does not identify as a mosga daemon SHALL cause a FAILED state with a clear reason and SHALL NOT be adopted or killed; no listener SHALL cause the shell to SPAWN its own daemon as a tracked child. A FAILED state SHALL never report running.

#### Scenario: A running mosga daemon is adopted

- **WHEN** the shell starts and `127.0.0.1:8899/api/health` identifies as a mosga daemon
- **THEN** the shell adopts it (no spawn) and reaches the running state marked adopted

#### Scenario: No listener leads to a spawned daemon

- **WHEN** nothing is listening on the port at startup
- **THEN** the shell spawns the daemon as a tracked child and reaches the running state once the port answers

#### Scenario: A foreign process on the port fails clearly

- **WHEN** a process that does not identify as a mosga daemon holds the port
- **THEN** the shell enters a failed state with a clear reason and neither adopts nor kills that process

### Requirement: Only a spawned daemon is shut down with the shell

The shell SHALL tree-kill the daemon on exit ONLY when it spawned that daemon; a daemon it adopted SHALL never be killed. Losing the spawned daemon's in-memory review state on shutdown is acceptable because a re-scan is deterministic and finding ids are stable.

#### Scenario: Spawned daemon dies with the shell

- **WHEN** the shell spawned the daemon and the shell exits
- **THEN** the spawned daemon process is terminated (no orphan)

#### Scenario: Adopted daemon outlives the shell

- **WHEN** the shell adopted an already-running daemon and the shell exits
- **THEN** the adopted daemon keeps running

### Requirement: Webview loads the daemon-served UI behind a status splash

The shell SHALL render a bundled splash immediately, show the adopt-or-spawn status (including a failure reason), and only once the daemon is running load the daemon-served UI at `http://127.0.0.1:8899/ui/` in the main webview. It SHALL reuse the daemon's same-origin UI unchanged and SHALL NOT require the daemon to serve cross-origin (CORS) responses.

#### Scenario: Splash shows startup status before the UI

- **WHEN** the daemon is still spawning
- **THEN** the shell shows the spawning status and does not display a blank webview

#### Scenario: UI loads once the daemon is running

- **WHEN** the daemon reaches running
- **THEN** the webview loads the daemon-served `/ui` and the review interface is usable

### Requirement: Loopback-only, no-remote-content security posture

The shell SHALL NOT widen the daemon's attack surface: the daemon stays bound to loopback only, the webview CSP SHALL permit only `self` and the loopback daemon origin (no remote hosts), and the shell SHALL introduce no handling of API keys or other secrets.

#### Scenario: CSP forbids remote content

- **WHEN** the webview is configured
- **THEN** its CSP allows connections only to `self` and `http://127.0.0.1:8899`, and no remote host

#### Scenario: Shell holds no secrets

- **WHEN** the shell runs
- **THEN** it reads, stores, and forwards no provider API keys (keys remain the daemon/direct-submit env/local-config concern)

### Requirement: The shell build does not gate Rust-less CI

The Rust/Tauri shell build SHALL be an opt-in script separate from the repository's aggregate `build`, `typecheck`, and `test`, so contributors and CI without a Rust toolchain keep those gates runnable. Installing the shell's Node dev-dependencies SHALL NOT require Rust.

#### Scenario: Existing gates run without Rust

- **WHEN** `npm run build`, `npm run typecheck`, and `npm test` run on a machine without Rust
- **THEN** they succeed without invoking the shell build

#### Scenario: Shell build is explicitly opt-in

- **WHEN** a contributor wants the desktop installer
- **THEN** they run the dedicated shell-build script, which is the only path that requires Rust and the Tauri CLI
