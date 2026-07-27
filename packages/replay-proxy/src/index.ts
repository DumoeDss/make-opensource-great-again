export { createReplayProxy } from './proxy.js';
export { DEFAULT_MAX_REQUEST_BYTES } from './types.js';

export type {
  ReplayApiFormat,
  ReplayHttpAddressInfo,
  ReplayHttpListener,
  ReplayHttpServerLike,
  ReplayIncomingRequest,
  ReplayOutboundRequest,
  ReplayOutgoingResponse,
  ReplayProxy,
  ReplayProxyErrorCode,
  ReplayProxyFailure,
  ReplayProxyOptions,
  ReplayProxyOutcome,
  ReplayProxyReceipt,
  ReplayProxyShutdownResult,
  ReplayProxyStage,
  ReplayRouteClosedState,
  ReplayRouteDisposeResult,
  ReplayRouteHandle,
  ReplayRouteOptions,
  ReplayRouteRegistration,
  ReplaySourceWireProtocol,
  ReplayUpstreamResponse,
  ReplayUpstreamTarget,
  ReplayUpstreamTransport,
} from './types.js';

// Re-export the consumed runtime route types so the proxy's public surface is
// self-contained for callers. Type-only: no runtime dependency cycle.
export type {
  ReplayRouteBinding,
  ReplayRouteRequirement,
} from '@mosga/replay-runtime';
