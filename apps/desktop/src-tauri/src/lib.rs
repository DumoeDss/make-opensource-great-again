// Tauri builder for the mosga desktop shell. On startup the shell adopt-or-spawns
// the loopback daemon (see `daemon_runtime`) and exposes an honest lifecycle
// status to the splash; once the daemon is running the splash navigates the main
// webview to the daemon-served same-origin UI (`http://127.0.0.1:8899/ui/`). A
// child the shell spawned is tree-killed on exit; an adopted daemon is not.
//
// The shell speaks to the daemon ONLY via same-origin HTTP from the loaded /ui
// page (no tauri-plugin-http, no CORS) and a single IPC command (`daemon_status`)
// the splash polls. It holds no API keys or secrets.

mod daemon_runtime;
mod kill;

use tauri::{Manager, RunEvent};

use daemon_runtime::{adopt_or_spawn, daemon_status, DaemonRuntime};

/// Ensure loopback hosts bypass any system/env HTTP proxy. The daemon is a
/// loopback-only service (127.0.0.1:8899); a global `HTTP(S)_PROXY` (e.g. Clash
/// on 127.0.0.1:7890) would otherwise route the adopt-or-spawn probe through the
/// proxy, which typically 502s on a loopback target — making a live daemon look
/// absent. We append the loopback hosts to `NO_PROXY`/`no_proxy` (merging, not
/// clobbering); other (non-loopback) traffic is unaffected. The probe client is
/// also built `.no_proxy()`; this belt-and-suspenders keeps env-derived proxies
/// off the loopback for any future client too. Must run before any reqwest build.
fn ensure_loopback_no_proxy() {
    const LOOPBACK: [&str; 2] = ["127.0.0.1", "localhost"];
    for key in ["NO_PROXY", "no_proxy"] {
        let current = std::env::var(key).unwrap_or_default();
        let mut hosts: Vec<String> = current
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        for h in LOOPBACK {
            if !hosts.iter().any(|x| x.eq_ignore_ascii_case(h)) {
                hosts.push(h.to_string());
            }
        }
        std::env::set_var(key, hosts.join(","));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Loopback daemon must never be proxied — set this BEFORE the adopt-or-spawn
    // probe builds its reqwest client.
    ensure_loopback_no_proxy();

    tauri::Builder::default()
        .manage(DaemonRuntime::new())
        .invoke_handler(tauri::generate_handler![daemon_status])
        .setup(|app| {
            let handle = app.handle().clone();

            // Reveal the window immediately so the splash (which polls
            // daemon_status) is visible during probe/spawn, not a blank frame.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            // Run adopt-or-spawn off the setup thread so window creation is not
            // blocked by the probe / spawn / wait-for-port loop.
            let spawn_handle = handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                adopt_or_spawn(spawn_handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running mosga-desktop")
        .run(|app, event| {
            // Tree-kill a daemon WE spawned on every clean exit path. An adopted
            // daemon (spawned == false) is left running — shutdown() no-ops.
            if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event {
                app.state::<DaemonRuntime>().shutdown();
            }
        });
}
