import { createServer, type Server } from 'node:http';

import type {
  ReplayHttpAddressInfo,
  ReplayHttpListener,
  ReplayHttpServerLike,
} from './types.js';

/**
 * Create the dedicated loopback HTTP listener for one route. Each registration
 * gets its own `http.Server` bound to exactly one loopback address on an
 * OS-assigned ephemeral port (port 0). One listener per route gives strong
 * isolation: there is no path or header routing table where a token from one
 * route could be replayed against another. The listener never binds to
 * `0.0.0.0`, terminates TLS, or sets SO_REUSEADDR beyond the Node default.
 */
export function createLoopbackServer(
  handler: ReplayHttpListener,
): ReplayHttpServerLike {
  const server = createServer((req, res) => {
    handler(req as never, res as never);
  });
  // The cast is safe: we only use listen/address/close/on, which node's Server
  // implements. The injected surface in types.ts is the minimal contract.
  return server as unknown as ReplayHttpServerLike;
}

/**
 * Reject any connection whose remote address is not the bound loopback family.
 * `::ffff:127.0.0.1` (IPv4-mapped IPv6) is accepted when the bound host is
 * `::1` or `localhost`; plain `127.0.0.1` is accepted for the IPv4 host.
 */
export function isLoopbackRemoteAddress(
  remoteAddress: string | undefined,
  boundHost: string,
): boolean {
  if (typeof remoteAddress !== 'string') return false;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1') return true;
  if (remoteAddress === '::ffff:127.0.0.1') {
    return boundHost === '::1' || boundHost === 'localhost';
  }
  return false;
}

/** Outcome of a bounded body read. */
export type BodyReadOutcome =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly reason: 'too-large' | 'read-error' };

/**
 * Read the raw request body fully into memory, bounded by `maxBytes`. Returns
 * the exact bytes the CLI sent (used unchanged for the CLI-request hash). A
 * body exceeding the bound yields `too-large`, classified by the route as a
 * receive-stage failure with a generic HTTP 400 to the CLI.
 */
export function readBoundedBody(
  req: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'error', listener: (err: Error) => void): unknown;
  },
  maxBytes: number,
): Promise<BodyReadOutcome> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const finish = (outcome: BodyReadOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // discard further chunks, keep draining
      total += chunk.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        // Do NOT resolve yet — drain the remaining body bytes so the keep-alive
        // connection is not corrupted by leftover request data when the handler
        // responds 400. The promise resolves on 'end'.
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        finish({ ok: false, reason: 'too-large' });
      } else {
        finish({ ok: true, body: Buffer.concat(chunks) });
      }
    });
    req.on('error', () => {
      finish({ ok: false, reason: 'read-error' });
    });
  });
}

/** Read the ephemeral port the OS assigned. */
export function readServerPort(server: ReplayHttpServerLike): number {
  const info = server.address();
  if (isAddressInfo(info)) {
    return info.port;
  }
  throw new Error('loopback server is not listening');
}

export function isAddressInfo(
  value: ReplayHttpAddressInfo | string | null,
): value is ReplayHttpAddressInfo {
  return typeof value === 'object' && value !== null;
}

export type { Server };
