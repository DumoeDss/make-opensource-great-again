// daemon_runtime.rs — adopt-or-spawn lifecycle for the mosga daemon.
//
// On app startup the shell must reach a daemon on 127.0.0.1:8899. This module:
//   1. probes /api/health and classifies the listener by the BODY identity
//      (`{ name: "mosga-daemon", version }` — the daemon sets no identity
//      header, and this policy needs no pid so the body suffices):
//        - a mosga daemon (ANY version) ⇒ ADOPT (no spawn, never killed);
//        - a foreign listener (answers but not a mosga daemon) ⇒ Failed with a
//          clear reason (never adopt, never kill what we can't identify);
//        - no listener (refused/timeout) ⇒ SPAWN our own tracked child;
//   2. resolves the daemon command (env override → bundled runtime → dev repo
//      default) and SPAWNS `node <entry> ui --no-open --port 8899`;
//   3. waits (bounded) for the port to answer ⇒ Running, else Failed{reason}+kill.
//
// mosga-specific divergence from omnicross (deliberate): the daemon holds
// in-memory review + per-reviewId pseudonym state and this is a single local
// user, so the shell adopts ANY mosga daemon (no version-kill) and only ever
// tree-kills a daemon IT spawned. Destroying an in-flight review is worse than a
// version skew for a local tool.
//
// The status is a Rust state machine exposed to the splash via the
// `daemon_status` command. A Failed state NEVER reports running. A child WE
// spawned is tree-killed on app exit; an adopted daemon is never killed.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::kill;

const DAEMON_PORT: u16 = 8899;
const PROBE_URL: &str = "http://127.0.0.1:8899/api/health";
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
const WAIT_ATTEMPTS: u32 = 40;
const WAIT_INTERVAL: Duration = Duration::from_millis(250);

/// Explicit override: absolute path to the daemon's `dist/cli.js`.
const ENTRY_ENV: &str = "MOSGA_DAEMON_ENTRY";
/// Relative path of the bundled daemon entry inside a packaged install's
/// resource dir (a future staging step ships it there; absent in this slice,
/// so resolution falls through to the dev repo default).
const BUNDLED_ENTRY: &str = "daemon-runtime/node_modules/@mosga/daemon/dist/cli.js";

/// Lifecycle state, serialized to the splash as `{ state, reason?, port?, adopted }`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    /// One of: probing | adopted | spawning | running | failed.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// True once a running daemon was adopted (not spawned by us).
    pub adopted: bool,
}

impl DaemonStatus {
    fn new(state: &str) -> Self {
        Self { state: state.into(), reason: None, port: None, adopted: false }
    }
    fn running(adopted: bool) -> Self {
        Self { state: "running".into(), reason: None, port: Some(DAEMON_PORT), adopted }
    }
    fn failed(reason: String) -> Self {
        Self { state: "failed".into(), reason: Some(reason), port: None, adopted: false }
    }
}

/// Shared, Tauri-managed handle. Tracks whether WE spawned (so kill-on-exit only
/// fires for our child) and the current status (read by the `daemon_status` cmd).
pub struct DaemonRuntime {
    inner: Mutex<RuntimeInner>,
}

struct RuntimeInner {
    status: DaemonStatus,
    /// True only when this app spawned the daemon (never kill an adopted one).
    spawned: bool,
    child: Option<Child>,
}

impl DaemonRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RuntimeInner {
                status: DaemonStatus::new("probing"),
                spawned: false,
                child: None,
            }),
        }
    }

    pub fn status(&self) -> DaemonStatus {
        self.inner.lock().expect("daemon runtime poisoned").status.clone()
    }

    fn set_status(&self, status: DaemonStatus) {
        self.inner.lock().expect("daemon runtime poisoned").status = status;
    }

    /// Register a freshly spawned child as OURS immediately, BEFORE wait-for-port
    /// completes. This closes the orphan window: if the shell exits during the
    /// ~10s startup wait, `shutdown()` (spawned == true) now tree-kills it instead
    /// of leaking a node process. Status is set to `spawning`.
    fn register_spawned(&self, child: Child) {
        let mut guard = self.inner.lock().expect("daemon runtime poisoned");
        guard.child = Some(child);
        guard.spawned = true;
        guard.status = DaemonStatus::new("spawning");
    }

    /// Tree-kill the spawned child (no-op if we adopted / never spawned).
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().expect("daemon runtime poisoned");
        if !guard.spawned {
            return;
        }
        if let Some(child) = guard.child.as_mut() {
            kill::kill_tree(child.id());
            let _ = child.wait();
        }
        guard.child = None;
        guard.spawned = false;
    }
}

/// What the health probe found (body-identity classification).
#[derive(Debug, PartialEq)]
enum Probe {
    /// Connection refused / timeout — nothing is listening.
    NoListener,
    /// Something answered HTTP but is not a mosga daemon — a foreign process owns
    /// the port; NEVER adopt and NEVER kill it.
    Foreign,
    /// A mosga daemon answered (`/api/health` body `name == "mosga-daemon"`).
    Mosga { version: String },
}

/// Classify a health response by its parsed JSON body. Pure — unit-tested.
/// Any answering listener whose body does not identify as a mosga daemon is
/// Foreign, regardless of HTTP status.
fn classify_health(body: Option<&serde_json::Value>) -> Probe {
    match body.and_then(|b| b.get("name")).and_then(|v| v.as_str()) {
        Some("mosga-daemon") => Probe::Mosga {
            version: body
                .and_then(|b| b.get("version"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        },
        _ => Probe::Foreign,
    }
}

/// Probe a health URL and classify the listener. A send error (refused/timeout)
/// is NoListener; any response is parsed and classified by body identity.
fn probe_url(url: &str) -> Probe {
    // `.no_proxy()` is load-bearing: the daemon is loopback-only, but a system/env
    // HTTP(S)_PROXY (e.g. Clash on 127.0.0.1:7890) would otherwise route this probe
    // through the proxy, which typically 502s on a loopback target — making a live
    // daemon look absent. Never proxy our own local daemon.
    let client = match reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return Probe::NoListener,
    };
    match client.get(url).send() {
        Err(_) => Probe::NoListener,
        Ok(resp) => {
            let body = resp.json::<serde_json::Value>().ok();
            classify_health(body.as_ref())
        }
    }
}

fn probe() -> Probe {
    probe_url(PROBE_URL)
}

/// True when anything answers on the daemon port (spawn-wait checks).
fn probe_alive() -> bool {
    !matches!(probe(), Probe::NoListener)
}

/// Resolve the daemon launch command from an explicit env override path.
/// Returns Err when the override points at a nonexistent file.
fn resolve_from_env(entry: &str) -> Result<Vec<String>, String> {
    let path = PathBuf::from(entry);
    if !path.exists() {
        return Err(format!("daemon entry not found: {entry}"));
    }
    Ok(vec!["node".into(), entry.to_string()])
}

/// The dev repo default entry path, anchored on the compile-time manifest dir
/// (NOT the runtime cwd, which is `target/…`). Layout:
/// `<repo>/apps/desktop/src-tauri` → three levels up to the repo root, then
/// `packages/daemon/dist/cli.js`. Not canonicalized (caller verifies existence).
fn dev_entry_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/daemon/dist/cli.js")
}

/// Resolve the daemon launch command, in priority order:
///   1. `MOSGA_DAEMON_ENTRY` (absolute path to a dist/cli.js) — explicit override;
///   2. the BUNDLED runtime under the app's resource dir (packaged installs);
///   3. the DEV default in the repo checkout.
/// Returns Err when none of them exists. All branches run PATH `node`.
fn resolve_daemon_command(app: &AppHandle) -> Result<Vec<String>, String> {
    if let Ok(entry) = std::env::var(ENTRY_ENV) {
        return resolve_from_env(&entry);
    }

    // BUNDLED: <resource_dir>/daemon-runtime/… — packaged installs ONLY.
    // Skipped in debug builds so a stale staged copy can't shadow the live repo
    // dist below ("I rebuilt the daemon but dev still runs old code").
    if !cfg!(debug_assertions) {
        if let Ok(res) = app.path().resource_dir() {
            let bundled = res.join(BUNDLED_ENTRY);
            if let Ok(bundled) = bundled.canonicalize() {
                return Ok(vec!["node".into(), strip_verbatim(&bundled)]);
            }
        }
    }

    // DEV default: <repo>/packages/daemon/dist/cli.js.
    // canonicalize() verifies existence AND resolves the `..` segments; it errors
    // if the file is missing (→ honest "daemon entry not found").
    let dev = dev_entry_path();
    let dev = dev.canonicalize().map_err(|_| {
        format!(
            "daemon entry not found (no MOSGA_DAEMON_ENTRY, no bundled runtime, no repo checkout): {}",
            dev.display()
        )
    })?;
    // strip_verbatim is LOAD-BEARING on Windows: canonicalize() returns an
    // extended-length `\\?\E:\…` path, which Node misparses as a UNC path and
    // lstat's `E:` → `EISDIR: illegal operation on a directory, lstat 'E:'`.
    Ok(vec!["node".into(), strip_verbatim(&dev)])
}

/// Strip Windows' `\\?\` (and `\\?\UNC\`) extended-length prefix from a
/// canonicalized path so external tools that don't understand verbatim paths
/// (Node's main-module resolver) receive a plain `E:\…` path. No-op on paths
/// without the prefix (i.e. always a no-op on non-Windows).
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

/// Spawn `node <entry> ui --no-open --port 8899` as a tracked child. Windows:
/// CREATE_NO_WINDOW (no console pops up). Unix: own process group so kill-tree
/// can signal the whole group. stderr is piped so a failed start yields a reason.
fn spawn(cmd: &[String]) -> Result<Child, String> {
    let mut command = Command::new(&cmd[0]);
    command
        .args(&cmd[1..])
        .arg("ui")
        .arg("--no-open")
        .arg("--port")
        .arg(DAEMON_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0); // new group; gid == child pid
    }

    command
        .spawn()
        .map_err(|e| format!("failed to spawn daemon ({}): {e}", cmd[0]))
}

/// Read a short tail of the child's stderr for a human failure reason.
fn stderr_tail(child: &mut Child) -> Option<String> {
    use std::io::Read;
    let mut buf = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut buf);
    }
    let trimmed = buf.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect())
    }
}

/// The adopt-or-spawn orchestration. Mutates the managed status as it goes.
/// Runs off the setup thread (called on tauri::async_runtime).
pub fn adopt_or_spawn(app: AppHandle) {
    let runtime = app.state::<DaemonRuntime>();
    runtime.set_status(DaemonStatus::new("probing"));

    // 1. ADOPT-OR-FAIL (body identity): adopt ANY mosga daemon (no version-kill,
    //    single-user stateful tool); fail on a foreign listener; spawn otherwise.
    match probe() {
        Probe::Mosga { .. } => {
            runtime.set_status(DaemonStatus::running(true));
            return;
        }
        Probe::Foreign => {
            runtime.set_status(DaemonStatus::failed(format!(
                "port {DAEMON_PORT} is held by a process that is not a mosga daemon — \
                 stop it and relaunch"
            )));
            return;
        }
        Probe::NoListener => {}
    }

    // 2. Resolve the launch command.
    let cmd = match resolve_daemon_command(&app) {
        Ok(c) => c,
        Err(reason) => {
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
    };

    // 3. SPAWN and register the child IMMEDIATELY so kill-on-exit owns it during
    //    the wait window (a shell close mid-startup must not orphan the node
    //    process). shutdown() only ever fires for a spawned child.
    runtime.set_status(DaemonStatus::new("spawning"));
    let child = match spawn(&cmd) {
        Ok(c) => c,
        Err(reason) => {
            runtime.set_status(DaemonStatus::failed(reason));
            return;
        }
    };
    runtime.register_spawned(child);

    // 4. wait_for_port: bounded re-probe; first success ⇒ running. The child now
    //    lives in the managed handle, so we operate on it under a brief lock each
    //    iteration (never holding the lock across the sleep, so daemon_status
    //    stays responsive).
    for _ in 0..WAIT_ATTEMPTS {
        {
            let mut guard = runtime.inner.lock().expect("daemon runtime poisoned");
            let Some(child) = guard.child.as_mut() else {
                // shutdown() reaped the child while we were waiting (shell closing).
                return;
            };
            // Child exited early ⇒ failed with its stderr tail; reap it.
            if let Ok(Some(exit)) = child.try_wait() {
                let reason = stderr_tail(child)
                    .unwrap_or_else(|| format!("daemon exited early ({exit})"));
                guard.child = None;
                guard.spawned = false;
                guard.status = DaemonStatus::failed(reason);
                return;
            }
        }
        if probe_alive() {
            let mut guard = runtime.inner.lock().expect("daemon runtime poisoned");
            // Only promote if we still own the child (shutdown didn't reap it).
            if guard.child.is_some() {
                guard.status = DaemonStatus::running(false);
            }
            return;
        }
        std::thread::sleep(WAIT_INTERVAL);
    }

    // 5. Timed out ⇒ tree-kill the child we spawned (through the managed handle)
    //    and fail.
    {
        let mut guard = runtime.inner.lock().expect("daemon runtime poisoned");
        if let Some(child) = guard.child.as_mut() {
            kill::kill_tree(child.id());
            let _ = child.wait();
        }
        guard.child = None;
        guard.spawned = false;
        guard.status = DaemonStatus::failed(format!(
            "daemon did not become reachable on 127.0.0.1:{DAEMON_PORT} within the startup window"
        ));
    }
}

/// Tauri command — the splash polls this until terminal.
#[tauri::command]
pub fn daemon_status(runtime: tauri::State<'_, DaemonRuntime>) -> DaemonStatus {
    runtime.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn classify_mosga_daemon_by_body() {
        let body = serde_json::json!({ "name": "mosga-daemon", "version": "0.1.0" });
        assert_eq!(classify_health(Some(&body)), Probe::Mosga { version: "0.1.0".into() });
    }

    #[test]
    fn classify_mosga_daemon_without_version() {
        let body = serde_json::json!({ "name": "mosga-daemon" });
        assert_eq!(classify_health(Some(&body)), Probe::Mosga { version: "".into() });
    }

    #[test]
    fn classify_foreign_listener() {
        let body = serde_json::json!({ "name": "something-else", "status": "ok" });
        assert_eq!(classify_health(Some(&body)), Probe::Foreign);
        // A body with no recognizable identity is also foreign.
        assert_eq!(classify_health(Some(&serde_json::json!({}))), Probe::Foreign);
        assert_eq!(classify_health(None), Probe::Foreign);
    }

    #[test]
    fn strip_verbatim_handles_windows_prefixes() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\E:\repo\cli.js")), r"E:\repo\cli.js");
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share\cli.js")),
            r"\\server\share\cli.js"
        );
        // No prefix ⇒ unchanged (the non-Windows case).
        assert_eq!(strip_verbatim(Path::new("/home/user/cli.js")), "/home/user/cli.js");
    }

    #[test]
    fn resolve_from_env_precedence() {
        // Existing file ⇒ Ok(["node", <path>]).
        let tmp = std::env::temp_dir().join("mosga-test-cli-entry.js");
        std::fs::write(&tmp, b"// stub\n").unwrap();
        let entry = tmp.to_string_lossy().into_owned();
        assert_eq!(resolve_from_env(&entry).unwrap(), vec!["node".to_string(), entry.clone()]);
        std::fs::remove_file(&tmp).ok();
        // Missing file ⇒ Err.
        assert!(resolve_from_env(&entry).is_err());
    }

    #[test]
    fn dev_entry_path_points_at_daemon_dist() {
        let p = dev_entry_path().to_string_lossy().replace('\\', "/");
        assert!(p.ends_with("packages/daemon/dist/cli.js"), "unexpected dev entry: {p}");
    }

    #[test]
    fn probe_url_refused_is_no_listener() {
        // Nothing binds this ephemeral-ish high port ⇒ connection refused.
        assert_eq!(probe_url("http://127.0.0.1:1/api/health"), Probe::NoListener);
    }

    /// A benign long-lived child, spawned in its own process group on Unix so
    /// kill-tree signals only it (never the test runner's group). Returns None if
    /// `node` is unavailable, so the test skips rather than fails.
    fn spawn_sleeper() -> Option<Child> {
        let mut command = Command::new("node");
        command
            .arg("-e")
            .arg("setTimeout(() => {}, 30000)")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn().ok()
    }

    /// m1 regression: a child is kill-eligible the instant it is registered —
    /// BEFORE wait-for-port — so a shell close during startup can't orphan it.
    #[test]
    fn registered_child_is_killed_by_shutdown() {
        let runtime = DaemonRuntime::new();
        let Some(child) = spawn_sleeper() else {
            return; // node absent — skip
        };
        let pid = child.id();
        runtime.register_spawned(child);
        {
            let guard = runtime.inner.lock().unwrap();
            assert!(guard.spawned, "register_spawned must mark the child as ours");
            assert!(guard.child.is_some(), "child must be tracked immediately");
            assert_eq!(guard.status.state, "spawning");
        }
        // shutdown() (spawned == true) must tree-kill and reap it.
        runtime.shutdown();
        {
            let guard = runtime.inner.lock().unwrap();
            assert!(!guard.spawned);
            assert!(guard.child.is_none());
        }
        let _ = pid; // pid captured for clarity; kill verified via handle clear + reap
    }

    /// An adopted daemon (never spawned) is never touched by shutdown().
    #[test]
    fn shutdown_is_noop_when_not_spawned() {
        let runtime = DaemonRuntime::new();
        runtime.set_status(DaemonStatus::running(true));
        runtime.shutdown(); // must not panic and must remain adopted-running
        let status = runtime.status();
        assert_eq!(status.state, "running");
        assert!(status.adopted);
    }

    /// Integration: a stub HTTP listener returning the mosga health body is
    /// classified as Mosga (adoption path — no spawn). Uses an ephemeral port so
    /// it never collides with a real daemon on 8899.
    #[test]
    fn probe_url_adopts_stub_mosga_daemon() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                // Read the request headers BEFORE responding: writing the response
                // and closing while the client is still sending resets the
                // connection on Windows, which the probe would see as NoListener.
                use std::io::Read;
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                // A single canned health response is sufficient for classification.
                let body = r#"{"name":"mosga-daemon","version":"9.9.9"}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        let url = format!("http://{addr}/api/health");
        assert_eq!(probe_url(&url), Probe::Mosga { version: "9.9.9".into() });
        let _ = handle.join();
    }
}
