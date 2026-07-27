import { randomBytes } from 'node:crypto';

import { buildBinding, validateLoopbackBinding, validateUpstreamTarget } from './binding.js';
import { createV1ConverterRegistry } from './converters/index.js';
import type {
  ReplayConversionContext,
  ReplayProtocolConverter,
} from './converters/types.js';
import { synthesizeStream } from './converters/streaming.js';
import { cliErrorBody, CLI_ERROR_TYPES, failure } from './errors.js';
import { sha256Digest } from './hashing.js';
import { extractBearerToken, generateRouteToken, validateRouteToken } from './token.js';
import { parseUsage } from './usage.js';
import {
  buildOutboundRequest,
  defaultTransport,
} from './transport.js';
import {
  createLoopbackServer,
  isLoopbackRemoteAddress,
  readBoundedBody,
  readServerPort,
} from './routeServer.js';
import type {
  ReplayHttpServerLike,
  ReplayProxy,
  ReplayProxyFailure,
  ReplayProxyOptions,
  ReplayProxyReceipt,
  ReplayRouteClosedState,
  ReplayRouteDisposeResult,
  ReplayRouteHandle,
} from './types.js';
import { DEFAULT_MAX_REQUEST_BYTES } from './types.js';
import type { ReplayUpstreamTransport } from './types.js';
import type { SourceCli } from '@mosga/contracts';

/**
 * Create a replay proxy. The proxy owns no shared server; each `registerRoute`
 * call creates its own dedicated loopback listener. The real upstream API key
 * is accepted ONLY by `registerRoute` (via `ReplayUpstreamTarget.upstreamApiKey`)
 * and stored in a non-exported route record cleared on dispose.
 */
export function createReplayProxy(options: ReplayProxyOptions = {}): ReplayProxy {
  const registry = createV1ConverterRegistry();
  const defaultLoopbackHost = options.loopbackHost ?? '127.0.0.1';
  const defaultMaxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const transport: ReplayUpstreamTransport = options.transport ?? defaultTransport;
  const randomSource = options.randomBytes ?? randomBytes;
  const now = options.now ?? (() => new Date());
  const createServerFn = options.createHttpServer ?? createLoopbackServer;

  const routes = new Map<string, RouteRecord>();
  let shutdownStarted = false;

  const registerRoute: ReplayProxy['registerRoute'] = async (
    requirement,
    upstream,
    routeOptions,
  ) => {
    if (shutdownStarted) {
      return {
        ok: false,
        error: failure('proxy-shutdown', 'register', 'failed'),
      };
    }

    const requirementMismatch = validateUpstreamTarget(requirement, upstream);
    if (requirementMismatch) {
      return { ok: false, error: requirementMismatch };
    }

    const converter = registry.lookup(
      requirement.wireProtocol,
      upstream.upstreamApiFormat,
    );
    if (!converter) {
      return {
        ok: false,
        error: failure('converter-unsupported', 'register', 'failed'),
      };
    }

    const loopbackHost = routeOptions?.loopbackHost ?? defaultLoopbackHost;
    const maxRequestBytes = routeOptions?.maxRequestBytes ?? defaultMaxRequestBytes;
    const routeToken = generateRouteToken(randomSource);
    const cliModel = requirement.targetModel;

    const record: RouteRecord = {
      id: `route_${randomSource(8).toString('hex')}`,
      requirement,
      upstream: {
        targetProviderId: upstream.targetProviderId,
        targetModel: upstream.targetModel,
        baseUrl: upstream.upstreamBaseUrl,
        // The real key lives ONLY here. Cleared on dispose. Never placed in the
        // binding, receipt, error response, log, or converter context.
        apiKey: upstream.upstreamApiKey,
        apiFormat: upstream.upstreamApiFormat,
      },
      converter,
      routeToken,
      cliModel,
      loopbackHost,
      maxRequestBytes,
      state: 'registered',
      latchClaimed: false,
      server: null,
      abortController: null,
      receiptResolve: null,
      receiptReject: null,
      receiptSettled: false,
      startedAt: null,
      secondRequestRejected: false,
    };

    const receipt = new Promise<ReplayProxyReceipt>((resolve, reject) => {
      record.receiptResolve = resolve;
      record.receiptReject = reject;
    });
    // Attach a rejection sink so a route that rejects its receipt (dispose,
    // token-invalid, converter failure) before the integration awaits it does
    // not surface as a process-level unhandled rejection. Anyone awaiting
    // `handle.receipt` still receives the rejection; this only prevents the
    // dangling-warning for the fire-and-forget path.
    receipt.catch(() => {});

    // Bind the dedicated loopback listener before returning so the handle's
    // binding carries the real ephemeral port.
    const server = createServerFn((req, res) => {
      void handleRequest(record, req, res);
    });
    record.server = server;

    try {
      await listenLoopback(server, loopbackHost);
    } catch {
      return {
        ok: false,
        error: failure('proxy-internal-error', 'listen', 'failed'),
      };
    }

    const port = readServerPort(server);
    const loopbackBaseUrl = formatLoopbackBaseUrl(loopbackHost, port);
    const binding = buildBinding(
      requirement,
      loopbackBaseUrl,
      routeToken,
      cliModel,
    );
    const bindingError = validateLoopbackBinding(binding);
    if (bindingError) {
      await closeServerQuietly(server);
      return {
        ok: false,
        error: failure('binding-invalid', 'listen', 'failed'),
      };
    }

    record.state = 'listening';
    routes.set(record.id, record);

    const handle: ReplayRouteHandle = {
      binding,
      receipt,
      async dispose(signal): Promise<ReplayRouteDisposeResult> {
        return disposeRoute(record, signal);
      },
    };

    return { ok: true, handle };
  };

  const shutdown: ReplayProxy['shutdown'] = async (signal) => {
    if (shutdownStarted) {
      return { ok: true, routesClosed: 0 };
    }
    shutdownStarted = true;
    const active = [...routes.values()];
    routes.clear();
    let count = 0;
    for (const record of active) {
      await disposeRoute(record, signal);
      count += 1;
    }
    return { ok: true, routesClosed: count };
  };

  // -----------------------------------------------------------------
  // Request handler — the one-shot route state machine.
  // -----------------------------------------------------------------

  async function handleRequest(
    record: RouteRecord,
    req: IncomingRequestLike,
    res: OutgoingResponseLike,
  ): Promise<void> {
    // (1) Loopback enforcement.
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress, record.loopbackHost)) {
      // Non-loopback: do not read the body. Return silently.
      return;
    }

    // (2) Token validation (BEFORE the latch — synchronous, reads the header).
    //     An invalid token must NOT consume the one-shot route: a subsequent
    //     valid-token request can still be accepted. Token comparison is
    //     constant-time and reads only req.headers, so it races no differently
    //     than the latch claim itself.
    const presentedToken = extractBearerFromHeaders(req.headers);
    if (!validateRouteToken(presentedToken, record.routeToken)) {
      respondGeneric(res, 401, CLI_ERROR_TYPES.tokenInvalid);
      return;
    }

    // (3) Read the raw CLI body (BEFORE the latch). An oversized body must NOT
    //     consume the route.
    const bodyRead = await readBoundedBody(req, record.maxRequestBytes);
    if (!bodyRead.ok) {
      respondGeneric(res, 400, CLI_ERROR_TYPES.requestTooLarge);
      return;
    }
    const cliRequestBody = bodyRead.body;

    // (4) Convert request (BEFORE the latch). A converter-failing body must NOT
    //     consume the route. Fail-closed on any structural error.
    const streamingRequested = detectStreaming(cliRequestBody);
    const context: ReplayConversionContext = {
      sourceProtocol: record.requirement.wireProtocol,
      targetFormat: record.upstream.apiFormat,
      upstreamBaseUrl: record.upstream.baseUrl,
      upstreamModel: record.upstream.targetModel,
      cliModel: record.cliModel,
      streamingRequested,
    };
    let converted;
    try {
      converted = record.converter.convertRequest(cliRequestBody, context);
    } catch {
      respondGeneric(res, 502, CLI_ERROR_TYPES.converterFailed);
      return;
    }

    // (5) One-shot latch: synchronous first-wins. Only a fully-valid request
    //     (loopback + valid token + bounded body + convertible) consumes the
    //     route. The latch is an atomic check-and-set, so concurrent valid
    //     requests race here safely — exactly one wins, the rest get 429.
    if (record.latchClaimed || record.state !== 'listening') {
      respondGeneric(res, 429, CLI_ERROR_TYPES.alreadyUsed);
      record.secondRequestRejected = true;
      return;
    }
    record.latchClaimed = true;
    record.state = 'received';
    record.startedAt = now().toISOString();

    // (6) CLI-request hash (before forwarding).
    const cliRequestHash = sha256Digest(cliRequestBody);

    // (7) Build outbound request (attach real key as converter-declared header).
    const outboundRequest = buildOutboundRequest(
      converted,
      record.upstream.baseUrl,
      record.upstream.apiKey,
    );
    const outboundRequestHash = sha256Digest(outboundRequest.body);

    // (9) Forward via transport (AbortSignal-aware for dispose).
    record.state = 'forwarding';
    const abortController = new AbortController();
    record.abortController = abortController;

    let upstreamResponse;
    try {
      upstreamResponse = await transport(outboundRequest, abortController.signal);
    } catch {
      // If the route was disposed mid-round-trip, dispose already settled the
      // receipt and closed the listener; do not relay or settle again.
      if (record.receiptSettled) {
        return;
      }
      // Network failure: relay a protocol-valid generic error so the CLI exits
      // cleanly, but record the real outcome. No retry, no fallback.
      relayUpstreamFailure(record, res);
      settleResolve(
        record,
        buildReceipt(
          record,
          cliRequestHash,
          outboundRequestHash,
          0,
          null,
          'upstream-request-failed',
        ),
      );
      await closeRoute(record);
      return;
    }

    // A concurrent dispose may have settled the receipt and closed the listener
    // while the transport was in flight; if so, do not relay or settle again.
    if (record.receiptSettled) {
      return;
    }

    // (10) Parse usage from the real upstream response.
    const usage = parseUsage(upstreamResponse.body, record.upstream.apiFormat);

    if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
      // (11a) 2xx: convert the response back to the CLI's wire protocol.
      record.state = 'relaying-response';
      let convertedResponseBody;
      try {
        convertedResponseBody = record.converter.convertResponse(
          upstreamResponse.body,
          context,
        );
      } catch {
        respondGeneric(res, 502, CLI_ERROR_TYPES.converterFailed);
        settleReject(
          record,
          failure('converter-response-failed', 'convert-response', 'failed'),
        );
        await closeRoute(record);
        return;
      }

      relaySuccess(
        res,
        convertedResponseBody,
        streamingRequested,
        record.requirement.wireProtocol,
      );
      settleResolve(
        record,
        buildReceipt(
          record,
          cliRequestHash,
          outboundRequestHash,
          upstreamResponse.status,
          usage,
          'inference-served',
        ),
      );
      await closeRoute(record);
      return;
    }

    // (11b) Non-2xx: relay a protocol-valid generic error (do NOT relay the
    //       upstream error body, which can echo the request or account ids).
    relayUpstreamNon2xx(res);
    settleResolve(
      record,
      buildReceipt(
        record,
        cliRequestHash,
        outboundRequestHash,
        upstreamResponse.status,
        usage,
        'upstream-non-2xx',
      ),
    );
    await closeRoute(record);
  }

  function relaySuccess(
    res: OutgoingResponseLike,
    convertedResponseBody: Uint8Array,
    streamingRequested: boolean,
    sourceProtocol: 'anthropic-messages' | 'openai-responses',
  ): void {
    if (streamingRequested) {
      const stream = synthesizeStream(sourceProtocol, convertedResponseBody);
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.end(Buffer.from(stream));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(Buffer.from(convertedResponseBody));
  }

  function relayUpstreamNon2xx(res: OutgoingResponseLike): void {
    // Synthesize a generic protocol-valid error body. The real upstream body is
    // never relayed (it can leak account/request detail). Use a stable 502 so
    // the CLI exits cleanly rather than retrying the upstream's 4xx.
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(genericProtocolErrorBody());
  }

  function relayUpstreamFailure(
    _record: RouteRecord,
    res: OutgoingResponseLike,
  ): void {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json');
    res.end(genericProtocolErrorBody());
  }

  function genericProtocolErrorBody(): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message:
            'The MOSGA replay proxy could not service this request.',
        },
      }),
      'utf8',
    );
  }

  function respondGeneric(
    res: OutgoingResponseLike,
    status: number,
    type: (typeof CLI_ERROR_TYPES)[keyof typeof CLI_ERROR_TYPES],
  ): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(cliErrorBody(type));
  }

  function buildReceipt(
    record: RouteRecord,
    cliRequestHash: `sha256:${string}`,
    outboundRequestHash: `sha256:${string}`,
    httpStatus: number,
    usage: ReplayProxyReceipt['usage'],
    outcome: ReplayProxyReceipt['outcome'],
  ): ReplayProxyReceipt {
    const completedAt = now();
    const startedAt = record.startedAt ?? completedAt.toISOString();
    return {
      sourceCli: record.requirement.sourceCli,
      sourceWireProtocol: record.requirement.wireProtocol,
      targetProviderId: record.upstream.targetProviderId,
      targetModel: record.upstream.targetModel,
      upstreamApiFormat: record.upstream.apiFormat,
      converterId: record.converter.id,
      converterVersion: record.converter.version,
      cliRequestHash,
      outboundRequestHash,
      requestCount: 1,
      httpStatus,
      outcome,
      usage,
      startedAt,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - new Date(startedAt).getTime(),
      routeClosed: 'single-shot-completed',
    };
  }

  function settleResolve(record: RouteRecord, receipt: ReplayProxyReceipt): void {
    if (record.receiptSettled) return;
    record.receiptSettled = true;
    record.state = 'completed';
    record.receiptResolve?.(receipt);
  }

  function settleReject(
    record: RouteRecord,
    failureValue: ReplayProxyFailure,
  ): void {
    if (record.receiptSettled) return;
    record.receiptSettled = true;
    record.state = 'closed';
    record.receiptReject?.(failureValue);
  }

  async function closeRoute(record: RouteRecord): Promise<void> {
    record.abortController?.abort();
    record.abortController = null;
    // Clear the real key immediately; the route is done.
    record.upstream.apiKey = '';
    routes.delete(record.id);
    await closeServerQuietly(record.server);
    record.server = null;
    if (record.state !== 'completed' && record.state !== 'disposed') {
      record.state = 'closed';
    }
  }

  return { registerRoute, shutdown };
}

// ---------------------------------------------------------------------------
// Internal route record + helpers.
// ---------------------------------------------------------------------------

interface RouteRecord {
  readonly id: string;
  readonly requirement: RouteRequirementLike;
  readonly upstream: {
    readonly targetProviderId: string;
    readonly targetModel: string;
    readonly baseUrl: string;
    apiKey: string;
    readonly apiFormat: 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';
  };
  readonly converter: ReplayProtocolConverter;
  readonly routeToken: string;
  readonly cliModel: string;
  readonly loopbackHost: '127.0.0.1' | '::1';
  readonly maxRequestBytes: number;
  state:
    | 'registered'
    | 'listening'
    | 'received'
    | 'forwarding'
    | 'relaying-response'
    | 'completed'
    | 'closed'
    | 'disposed';
  latchClaimed: boolean;
  server: ReplayHttpServerLike | null;
  abortController: AbortController | null;
  receiptResolve: ((receipt: ReplayProxyReceipt) => void) | null;
  receiptReject: ((failure: ReplayProxyFailure) => void) | null;
  receiptSettled: boolean;
  startedAt: string | null;
  secondRequestRejected: boolean;
}

interface RouteRequirementLike {
  readonly sourceCli: SourceCli;
  readonly wireProtocol: 'anthropic-messages' | 'openai-responses';
  readonly transport: 'loopback-http';
  readonly authScheme: 'route-bearer';
  readonly targetProviderId: string;
  readonly targetModel: string;
}

interface IncomingRequestLike {
  readonly method?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

interface OutgoingResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(data?: Buffer | string): unknown;
}

async function disposeRoute(
  record: RouteRecord,
  _signal?: AbortSignal,
): Promise<ReplayRouteDisposeResult> {
  if (record.state === 'disposed') {
    return { ok: true, routeClosed: 'disposed-unused' };
  }
  const hadRequest = record.latchClaimed;
  record.abortController?.abort();
  record.upstream.apiKey = '';
  record.state = 'disposed';
  if (!record.receiptSettled) {
    const routeClosed: ReplayRouteClosedState = hadRequest
      ? 'disposed-mid-round-trip'
      : 'disposed-unused';
    settleRejectRaw(record, failure('route-disposed', 'dispose', routeClosed));
  }
  await closeServerQuietly(record.server);
  record.server = null;
  return {
    ok: true,
    routeClosed: hadRequest ? 'disposed-mid-round-trip' : 'disposed-unused',
  };
}

function settleRejectRaw(
  record: RouteRecord,
  failureValue: ReplayProxyFailure,
): void {
  if (record.receiptSettled) return;
  record.receiptSettled = true;
  record.receiptReject?.(failureValue);
}

function listenLoopback(
  server: ReplayHttpServerLike,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.on('error', onError);
    server.listen(0, host, () => {
      resolve();
    });
  });
}

async function closeServerQuietly(
  server: ReplayHttpServerLike | null,
): Promise<void> {
  if (!server) return;
  // Destroy in-flight connections first so close() does not deadlock waiting
  // on a handler that is blocked on the (possibly-aborted) upstream transport.
  try {
    server.closeAllConnections?.();
  } catch {
    // ignore — not all injected servers implement this.
  }
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function formatLoopbackBaseUrl(host: string, port: number): string {
  if (host === '::1') {
    return `http://[::1]:${port}`;
  }
  return `http://${host}:${port}`;
}

function extractBearerFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // node:http lowercases header keys; injected fakes may use either casing.
  const value = headers['authorization'] ?? headers['Authorization'];
  return extractBearerToken(value);
}

function detectStreaming(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const stream = (parsed as { stream?: unknown }).stream;
      return stream === true;
    }
  } catch {
    // not JSON — no streaming requested.
  }
  return false;
}
