#!/usr/bin/env node
/**
 * `mosga ui` — start the loopback daemon and open the browser at `/ui`.
 *
 * Port resolution: `--port N` flag, else `MOSGA_PORT` env, else 8899. On a busy
 * port the launcher probes whether an existing mosga daemon already owns it: if
 * so it ADOPTS it (just opens the browser); otherwise it reports the conflict
 * clearly and exits non-zero (design D3 — full adopt-or-spawn negotiation is
 * trimmed to "adopt ours, else fail" for v0.1).
 */
import { spawn } from 'node:child_process';

import { DEFAULT_PORT, LOOPBACK_HOST, startDaemon } from './server.js';

interface CliArgs {
  port: number;
  command: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let port = Number(process.env.MOSGA_PORT) || DEFAULT_PORT;
  let command = '';
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (!command) {
      command = arg;
    }
  }
  return { port, command, help };
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
  mosga ui [--port N]

Options:
  -p, --port N   Port to bind on 127.0.0.1 (default ${DEFAULT_PORT}, or $MOSGA_PORT)
  -h, --help     Show this help

The daemon binds loopback only and has no authentication (v0.1 threat model:
single local user). See the @mosga/daemon README.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args.command && args.command !== 'ui')) {
    process.stdout.write(`${HELP}\n`);
    if (args.command && args.command !== 'ui') process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    process.stderr.write(`Invalid port: ${String(args.port)}\n`);
    process.exitCode = 2;
    return;
  }

  const uiUrl = `http://${LOOPBACK_HOST}:${args.port}/ui/`;

  try {
    const daemon = await startDaemon({ port: args.port });
    process.stdout.write(`mosga daemon listening on ${daemon.url}\n`);
    process.stdout.write(`Opening ${daemon.url}/ui/ …\n`);
    openBrowser(`${daemon.url}/ui/`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      const adoptable = await probeMosgaDaemon(args.port);
      if (adoptable) {
        process.stdout.write(
          `A mosga daemon is already running on port ${args.port}; adopting it.\n`,
        );
        process.stdout.write(`Opening ${uiUrl} …\n`);
        openBrowser(uiUrl);
        return;
      }
      process.stderr.write(
        `Port ${args.port} is in use by another process (not a mosga daemon). ` +
          `Choose another port with --port N.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Failed to start daemon: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
