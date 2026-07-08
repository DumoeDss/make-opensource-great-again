#!/usr/bin/env node
/**
 * `mosga ui` — start the loopback daemon and open the browser at `/ui`.
 *
 * Port resolution: `--port N` flag, else `MOSGA_PORT` env, else 8899. On a busy
 * port the launcher probes whether an existing mosga daemon already owns it: if
 * so it ADOPTS it (just opens the browser); otherwise it reports the conflict
 * clearly and exits non-zero (design D3 — full adopt-or-spawn negotiation is
 * trimmed to "adopt ours, else fail" for v0.1).
 *
 * `--no-open` starts the daemon WITHOUT launching the OS browser, so the Tauri
 * desktop shell can spawn the daemon and load `/ui` in its own webview (it prints
 * the URL instead). Loopback-only binding is unchanged in both modes.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULT_PORT, LOOPBACK_HOST, type RunningDaemon, startDaemon } from './server.js';

interface CliArgs {
  port: number;
  command: string;
  help: boolean;
  noOpen: boolean;
}

/** Injectable seams so tests can spy the browser opener and daemon start. */
export interface CliDeps {
  openBrowser: (url: string) => void;
  startDaemon: typeof startDaemon;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function parseArgs(argv: string[]): CliArgs {
  let port = Number(process.env.MOSGA_PORT) || DEFAULT_PORT;
  let command = '';
  let help = false;
  let noOpen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--no-open') {
      noOpen = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!command) {
      command = arg;
    }
  }
  return { port, command, help, noOpen };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Opening the browser is best-effort; the URL is printed regardless.
  }
}

/** Is the given port already served by a mosga daemon we can adopt? */
async function probeMosgaDaemon(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/api/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: string };
    return body.name === 'mosga-daemon';
  } catch {
    return false;
  }
}

const HELP = `mosga ui — local session review daemon

Usage:
  mosga ui [--port N] [--no-open]

Options:
  -p, --port N   Port to bind on 127.0.0.1 (default ${DEFAULT_PORT}, or $MOSGA_PORT)
      --no-open  Start the daemon without opening the OS browser (prints the URL);
                 used by the desktop shell, which loads /ui in its own webview
  -h, --help     Show this help

The daemon binds loopback only and has no authentication (v0.1 threat model:
single local user). See the @mosga/daemon README.`;

const defaultDeps: CliDeps = {
  openBrowser,
  startDaemon,
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
};

/**
 * Run the `mosga ui` launcher. Returns the started daemon (so callers/tests can
 * close it) or `undefined` when it adopted/failed/printed help. Deps are
 * injectable for tests (spy the opener without launching a real browser).
 */
export async function run(
  argv: string[],
  deps: Partial<CliDeps> = {},
): Promise<RunningDaemon | undefined> {
  const { openBrowser: open, startDaemon: start, stdout, stderr } = { ...defaultDeps, ...deps };
  const args = parseArgs(argv);
  if (args.help || (args.command && args.command !== 'ui')) {
    stdout(`${HELP}\n`);
    if (args.command && args.command !== 'ui') process.exitCode = 2;
    return undefined;
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    stderr(`Invalid port: ${String(args.port)}\n`);
    process.exitCode = 2;
    return undefined;
  }

  const uiUrl = `http://${LOOPBACK_HOST}:${args.port}/ui/`;

  try {
    const daemon = await start({ port: args.port });
    stdout(`mosga daemon listening on ${daemon.url}\n`);
    if (args.noOpen) {
      // The shell loads /ui in its own webview; just advertise the URL.
      stdout(`Open ${daemon.url}/ui/ in your browser.\n`);
    } else {
      stdout(`Opening ${daemon.url}/ui/ …\n`);
      open(`${daemon.url}/ui/`);
    }
    return daemon;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const adoptable = await probeMosgaDaemon(args.port);
      if (adoptable) {
        stdout(`A mosga daemon is already running on port ${args.port}; adopting it.\n`);
        if (args.noOpen) {
          stdout(`Open ${uiUrl} in your browser.\n`);
        } else {
          stdout(`Opening ${uiUrl} …\n`);
          open(uiUrl);
        }
        return undefined;
      }
      stderr(
        `Port ${args.port} is in use by another process (not a mosga daemon). ` +
          `Choose another port with --port N.\n`,
      );
      process.exitCode = 1;
      return undefined;
    }
    stderr(`Failed to start daemon: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return undefined;
  }
}

/**
 * Is this module the process entrypoint (the `mosga` bin), rather than an import
 * (e.g. a test)? `argv1` is the launched path; on macOS/Linux the npm `mosga`
 * bin is a SYMLINK to `dist/cli.js`, while `importMetaUrl` is realpath-resolved,
 * so a raw compare never matches — resolve `argv1` through `realpathSync` first.
 * Falls back to the raw path if `argv1` can't be resolved (e.g. it doesn't exist).
 */
export function isEntrypoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // argv1 may not exist / not be resolvable; fall back to the raw comparison.
  }
  return importMetaUrl === pathToFileURL(resolved).href;
}

// Auto-run only when invoked as the `mosga` bin, not when imported by a test.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  void run(process.argv.slice(2));
}
