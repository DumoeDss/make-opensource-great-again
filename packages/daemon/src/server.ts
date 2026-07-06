/**
 * Loopback HTTP server lifecycle. Binds `127.0.0.1` ONLY — never a non-loopback
 * interface (v0.1 threat model: single local user, no auth; see README).
 */
import { createServer, type Server } from 'node:http';

import { type App, type AppOptions, createApp } from './app.js';

/** The one and only host the daemon ever binds. */
export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8899;

export interface DaemonOptions extends AppOptions {
  port?: number;
}

export interface RunningDaemon {
  app: App;
  server: Server;
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

/** Start the daemon on `127.0.0.1:<port>` (default 8899). */
export function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const port = options.port ?? DEFAULT_PORT;
  const app = createApp(options);
  const server = createServer(app.requestListener);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // The host argument is hard-wired to loopback; the port may be 0 (ephemeral,
    // used by tests) but the interface is never externally reachable.
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        app,
        server,
        port: boundPort,
        host: LOOPBACK_HOST,
        url: `http://${LOOPBACK_HOST}:${boundPort}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
