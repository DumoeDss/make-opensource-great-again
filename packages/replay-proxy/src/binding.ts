import type { ReplayRouteBinding, ReplayRouteRequirement } from '@mosga/replay-runtime';

import { failure } from './errors.js';
import type {
  ReplayProxyFailure,
  ReplayUpstreamTarget,
} from './types.js';

/**
 * Validate that the upstream target's sealed fields exactly match the runtime's
 * route requirement and that the upstream base URL and credential are usable.
 *
 * The upstream base URL MUST be absolute HTTPS, NOT loopback, and free of
 * userinfo/query/fragment. An explicit local-test HTTP exception is allowed only
 * for `localhost`/`127.0.0.1`/`::1` (so hermetic tests can target a fake
 * loopback upstream) — production targets must be HTTPS and non-loopback.
 *
 * Returns a `ReplayProxyFailure` (`registration-invalid`) for any mismatch;
 * `registerRoute` turns that into a no-listener failure result.
 */
export function validateUpstreamTarget(
  requirement: ReplayRouteRequirement,
  upstream: ReplayUpstreamTarget,
): ReplayProxyFailure | null {
  if (upstream.targetProviderId !== requirement.targetProviderId) {
    return failure('registration-invalid', 'register', 'failed');
  }
  if (upstream.targetModel !== requirement.targetModel) {
    return failure('registration-invalid', 'register', 'failed');
  }
  if (
    typeof upstream.upstreamApiKey !== 'string' ||
    upstream.upstreamApiKey.length === 0
  ) {
    return failure('registration-invalid', 'register', 'failed');
  }
  const urlError = validateUpstreamBaseUrl(upstream.upstreamBaseUrl);
  if (urlError) {
    return failure('registration-invalid', 'register', 'failed');
  }
  return null;
}

export function validateUpstreamBaseUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return 'upstream base URL is not a valid absolute URL';
  }
  const isLoopbackHost =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1';
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHost) {
      return 'upstream base URL must be HTTPS unless targeting loopback for local tests';
    }
  } else if (parsed.protocol !== 'https:') {
    return 'upstream base URL must use http or https protocol';
  } else if (isLoopbackHost) {
    // An HTTPS loopback upstream is suspicious — refuse so production never
    // forwards to another loopback listener by accident.
    return 'upstream base URL must not target a loopback address';
  }
  if (parsed.username || parsed.password) {
    return 'upstream base URL must not carry userinfo';
  }
  if (parsed.search) {
    return 'upstream base URL must not carry a query string';
  }
  if (parsed.hash) {
    return 'upstream base URL must not carry a fragment';
  }
  return null;
}

/**
 * Build the typed `ReplayRouteBinding` the integration passes to
 * `PreparedReplay.execute`. Every source/protocol/auth/target field is repeated
 * from the sealed requirement; the loopback `baseUrl`, the route token, and the
 * cliModel are the proxy-supplied additions.
 */
export function buildBinding(
  requirement: ReplayRouteRequirement,
  loopbackBaseUrl: string,
  routeToken: string,
  cliModel: string,
): ReplayRouteBinding {
  return {
    sourceCli: requirement.sourceCli,
    wireProtocol: requirement.wireProtocol,
    transport: requirement.transport,
    authScheme: requirement.authScheme,
    targetProviderId: requirement.targetProviderId,
    targetModel: requirement.targetModel,
    baseUrl: loopbackBaseUrl,
    routeToken,
    cliModel,
  };
}

/**
 * Validate that a constructed binding satisfies the runtime's loopback
 * constraint: plain HTTP on `localhost`/`127.0.0.1`/`::1`, an explicit port, no
 * userinfo/query/fragment. This is a defensive self-check; an invalid binding
 * here is an internal proxy bug.
 */
export function validateLoopbackBinding(binding: ReplayRouteBinding): string | null {
  let parsed: URL;
  try {
    parsed = new URL(binding.baseUrl);
  } catch {
    return 'binding baseUrl is not a valid URL';
  }
  if (parsed.protocol !== 'http:') {
    return 'binding baseUrl must be plain HTTP on loopback';
  }
  // WHATWG URL serializes IPv6 hosts with brackets ([::1]); normalize both forms.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (
    host !== '127.0.0.1' &&
    host !== 'localhost' &&
    host !== '::1'
  ) {
    return 'binding baseUrl must target a loopback host';
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return 'binding baseUrl must have an explicit positive port';
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'binding baseUrl must not carry userinfo/query/fragment';
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return 'binding baseUrl must not carry a path';
  }
  if (typeof binding.routeToken !== 'string' || binding.routeToken.length === 0) {
    return 'binding routeToken must be non-empty';
  }
  if (typeof binding.cliModel !== 'string' || binding.cliModel.length === 0) {
    return 'binding cliModel must be non-empty';
  }
  return null;
}
