import type { SubmissionUsage, SourceCli } from '@mosga/contracts';

import type {
  ReplayRouteBinding,
  ReplayRouteRequirement,
} from '@mosga/replay-runtime';

/**
 * The wire protocol the source CLI speaks on the loopback route, and the
 * envelope shape its request/response bodies use. Mirrors the runtime's sealed
 * `ReplayRouteRequirement.wireProtocol`.
 */
export type ReplaySourceWireProtocol = 'anthropic-messages' | 'openai-responses';

/**
 * The API format the real upstream provider expects on the single outbound
 * request. The converter selected at registration maps
 * `ReplaySourceWireProtocol` -> `ReplayApiFormat`.
 */
export type ReplayApiFormat =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses';

/**
 * Stable, closed v1 failure-code set. Every public proxy failure carries one of
 * these codes. No code leaks the route token, the real API key, full request or
 * response bodies, system prompts, tool schemas, provider error bodies, or any
 * absolute upstream URL beyond what the caller already supplied.
 */
export type ReplayProxyErrorCode =
  | 'registration-invalid'
  | 'binding-invalid'
  | 'converter-unsupported'
  | 'converter-request-failed'
  | 'converter-response-failed'
  | 'route-token-invalid'
  | 'route-not-found'
  | 'route-already-used'
  | 'route-disposed'
  | 'upstream-request-failed'
  | 'upstream-non-2xx'
  | 'proxy-disposed'
  | 'proxy-shutdown'
  | 'proxy-internal-error';

/**
 * The pipeline stage at which a failure was classified. Stable v1 set.
 */
export type ReplayProxyStage =
  | 'register'
  | 'listen'
  | 'receive'
  | 'convert-request'
  | 'forward'
  | 'convert-response'
  | 'relay'
  | 'dispose';

/**
 * Coarse lifecycle state of a route when it closed. The receipt's resolved
 * `routeClosed` field is the narrow success-oriented subset; this broader set is
 * carried by failures and internal records.
 */
export type ReplayRouteClosedState =
  | 'open'
  | 'single-shot-completed'
  | 'disposed-unused'
  | 'disposed-mid-round-trip'
  | 'rejected-second-request'
  | 'failed';

/**
 * The only shape a public proxy failure takes. Contains nothing but stable
 * identifiers — never a raw cause, key, token, body, or URL.
 */
export interface ReplayProxyFailure {
  readonly code: ReplayProxyErrorCode;
  readonly stage: ReplayProxyStage;
  readonly routeClosed: ReplayRouteClosedState;
}

/**
 * The real upstream target. `registerRoute` is the single public entry point
 * that accepts the real provider API key; the key never leaves the non-exported
 * route record thereafter except as the converter-selected authorization header
 * on the one outbound request.
 */
export interface ReplayUpstreamTarget {
  readonly targetProviderId: string;
  readonly targetModel: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly upstreamApiFormat: ReplayApiFormat;
}

/**
 * Per-route options. `loopbackHost` selects the loopback family the dedicated
 * listener binds to (default `127.0.0.1`; `::1` accepted). `maxRequestBytes`
 * bounds the raw CLI request body read into memory.
 */
export interface ReplayRouteOptions {
  readonly loopbackHost?: '127.0.0.1' | '::1';
  readonly maxRequestBytes?: number;
}

/**
 * Outcome of a round-trip that the receipt records. `inference-served` means a
 * 2xx upstream response was converted and relayed. `upstream-non-2xx` and
 * `upstream-request-failed` mean the CLI still received a protocol-valid
 * response (so it exits cleanly) but no inference was served; the receipt
 * resolves in all three cases so the integration can record the audit trail.
 */
export type ReplayProxyOutcome =
  | 'inference-served'
  | 'upstream-non-2xx'
  | 'upstream-request-failed';

/**
 * Audit receipt for one completed round-trip. Records the CLI-request and
 * outbound-request hashes (distinct from the bundle content hash, which the
 * integration supplies separately), the converter id/version, request count,
 * upstream HTTP status, normalized usage, and timing. NEVER includes the real
 * API key, the route token, full request/response bodies, system prompts, tool
 * schemas, the workspace path, or any CLI-generated content.
 */
export interface ReplayProxyReceipt {
  readonly sourceCli: SourceCli;
  readonly sourceWireProtocol: ReplaySourceWireProtocol;
  readonly targetProviderId: string;
  readonly targetModel: string;
  readonly upstreamApiFormat: ReplayApiFormat;
  readonly converterId: string;
  readonly converterVersion: string;
  readonly cliRequestHash: `sha256:${string}`;
  readonly outboundRequestHash: `sha256:${string}`;
  readonly requestCount: number;
  readonly httpStatus: number;
  readonly outcome: ReplayProxyOutcome;
  readonly usage: SubmissionUsage | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly routeClosed:
    | 'single-shot-completed'
    | 'disposed-unused'
    | 'rejected-second-request';
}

/**
 * Result of disposing a single route. Always idempotent; a second dispose
 * reports the already-closed state.
 */
export interface ReplayRouteDisposeResult {
  readonly ok: true;
  readonly routeClosed: 'disposed-unused' | 'disposed-mid-round-trip';
}

/**
 * Result of shutting the proxy down. Disposes every active route.
 */
export interface ReplayProxyShutdownResult {
  readonly ok: true;
  readonly routesClosed: number;
}

/**
 * Handle to one registered route. `binding` is the value the integration passes
 * to `PreparedReplay.execute`. `receipt` settles exactly once when the
 * round-trip completes (resolves) or the route closes without a round-trip
 * (rejects with a stable failure). `dispose` is idempotent and aborts any
 * in-flight upstream request.
 */
export interface ReplayRouteHandle {
  readonly binding: ReplayRouteBinding;
  readonly receipt: Promise<ReplayProxyReceipt>;
  dispose(signal?: AbortSignal): Promise<ReplayRouteDisposeResult>;
}

/**
 * Registration is synchronous and returns immediately; the listener is already
 * bound when the handle is returned. A failure result carries a stable code and
 * starts no listener.
 */
export type ReplayRouteRegistration =
  | { readonly ok: true; readonly handle: ReplayRouteHandle }
  | { readonly ok: false; readonly error: ReplayProxyFailure };

/**
 * Injectable outbound transport. The default implementation uses the platform
 * `fetch`. A fake transport is the only way focused tests drive the upstream
 * leg; no test contacts a real provider.
 */
export interface ReplayOutboundRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

export interface ReplayUpstreamResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export type ReplayUpstreamTransport = (
  request: ReplayOutboundRequest,
  signal?: AbortSignal,
) => Promise<ReplayUpstreamResponse>;

/**
 * Factory options. `loopbackHost`/`maxRequestBytes` are route defaults overridable
 * per registration. `transport`/`randomBytes`/`now`/`createServer` are injection
 * seams for hermetic tests.
 */
export interface ReplayProxyOptions {
  readonly loopbackHost?: '127.0.0.1' | '::1';
  readonly maxRequestBytes?: number;
  readonly transport?: ReplayUpstreamTransport;
  readonly randomBytes?: (byteLength: number) => Uint8Array;
  readonly now?: () => Date;
  readonly createHttpServer?: (handler: ReplayHttpListener) => ReplayHttpServerLike;
}

/**
 * Minimal injected HTTP-server surface. Tests may supply a fake; production uses
 * `node:http`. The proxy only needs `listen`, `address`, and `close`.
 */
export type ReplayHttpListener = (
  req: ReplayIncomingRequest,
  res: ReplayOutgoingResponse,
) => void;

export interface ReplayIncomingRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface ReplayOutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(data?: Buffer | string): unknown;
}

export interface ReplayHttpAddressInfo {
  readonly address: string;
  readonly port: number;
  readonly family: string;
}

export interface ReplayHttpServerLike {
  listen(
    port: number,
    host: string,
    callback?: () => void,
  ): ReplayHttpServerLike;
  address(): ReplayHttpAddressInfo | string | null;
  close(callback?: (err?: Error) => void): unknown;
  on(event: string, listener: (err: Error) => void): ReplayHttpServerLike;
  /** Destroy all in-flight connections immediately (Node 18.2+). Optional. */
  closeAllConnections?(): unknown;
}

/**
 * The public proxy registrar. `registerRoute` consumes a runtime route
 * requirement and a separately resolved upstream target and produces a typed
 * binding for the runtime's `execute`. `shutdown` disposes every active route
 * and refuses further registration.
 */
export interface ReplayProxy {
  /**
   * Async because the dedicated loopback listener's OS-assigned ephemeral port
   * is only known after `listen()` resolves; the binding handed back carries
   * that port. (The propose-stage design sketched a synchronous return; the real
   * port-assignment boundary makes an async signature the correct shape.)
   */
  registerRoute(
    requirement: ReplayRouteRequirement,
    upstream: ReplayUpstreamTarget,
    options?: ReplayRouteOptions,
  ): Promise<ReplayRouteRegistration>;
  shutdown(signal?: AbortSignal): Promise<ReplayProxyShutdownResult>;
}

/** Default bound on the raw CLI request body (1 MiB). */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
