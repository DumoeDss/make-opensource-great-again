// Splash controller: poll the Rust `daemon_status` command and, once the daemon
// is running, navigate this single webview to the daemon-served same-origin UI.
// While probing/spawning it shows a status line; on failure it shows the reason.
// This runs on the bundled tauri:// origin, so the Tauri IPC bridge is available
// (withGlobalTauri). Once we navigate to http://127.0.0.1:8899/ui/, IPC is gone —
// fine, the UI only speaks same-origin HTTP to the daemon, never IPC.

const invoke = window.__TAURI__.core.invoke;

const DAEMON_UI_URL = 'http://127.0.0.1:8899/ui/';
const POLL_INTERVAL_MS = 300;

const statusEl = document.getElementById('status');
const reasonEl = document.getElementById('reason');
const spinnerEl = document.getElementById('spinner');

const LABELS = {
  probing: 'Looking for the mosga daemon…',
  spawning: 'Starting the mosga daemon…',
  running: 'Ready — loading the review UI…',
  adopted: 'Connected to a running mosga daemon…',
};

function render(status) {
  const label = LABELS[status.state] || `Daemon status: ${status.state}`;
  statusEl.textContent = status.adopted && status.state === 'running' ? LABELS.adopted : label;
  if (status.state === 'failed') {
    spinnerEl.classList.add('hidden');
    statusEl.textContent = 'Could not start the mosga daemon.';
    reasonEl.textContent = status.reason || 'Unknown error.';
    reasonEl.classList.remove('hidden');
  }
}

async function poll() {
  try {
    const status = await invoke('daemon_status');
    render(status);
    if (status.state === 'running') {
      // Navigate the main webview to the daemon's same-origin SPA. No IPC needed
      // there; the UI talks HTTP to the same origin it was served from.
      window.location.replace(DAEMON_UI_URL);
      return;
    }
    if (status.state === 'failed') {
      return; // terminal — stop polling, leave the reason on screen
    }
  } catch (err) {
    statusEl.textContent = 'Waiting for the desktop shell…';
    reasonEl.classList.add('hidden');
  }
  setTimeout(poll, POLL_INTERVAL_MS);
}

poll();
