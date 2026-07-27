import type {
  ReplayAuthScheme,
  ReplayConvertedRequest,
} from './converters/types.js';
import type {
  ReplayOutboundRequest,
  ReplayUpstreamResponse,
  ReplayUpstreamTransport,
} from './types.js';

/**
 * Build the final outbound request headers. The converter declares the auth
 * scheme and supplies every non-auth header; this helper attaches the real API
 * key as the converter-selected authorization header. The key is read from the
 * non-exported route record by the caller and never appears in the converted
 * request, the receipt, or a log.
 */
export function buildOutboundRequest(
  converted: ReplayConvertedRequest,
  upstreamBaseUrl: string,
  realApiKey: string,
): ReplayOutboundRequest {
  const headers: Record<string, string> = { ...converted.headers };
  headers[authHeaderName(converted.authScheme)] = authHeaderValue(
    converted.authScheme,
    realApiKey,
  );
  const base = upstreamBaseUrl.endsWith('/')
    ? upstreamBaseUrl.slice(0, -1)
    : upstreamBaseUrl;
  return {
    url: `${base}${converted.targetPath}`,
    method: 'POST',
    headers,
    body: converted.body,
  };
}

export function authHeaderName(scheme: ReplayAuthScheme): string {
  return scheme === 'x-api-key' ? 'x-api-key' : 'authorization';
}

export function authHeaderValue(scheme: ReplayAuthScheme, apiKey: string): string {
  return scheme === 'x-api-key' ? apiKey : `Bearer ${apiKey}`;
}

/**
 * The default upstream transport: platform `fetch`. Reads the response body
 * fully into memory (the response is a single throwaway completion). A fake
 * transport injected via `ReplayProxyOptions.transport` is the only path tests
 * use; production never contacts a real provider from this package's tests.
 */
export const defaultTransport: ReplayUpstreamTransport = async (
  request,
  signal,
): Promise<ReplayUpstreamResponse> => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
    redirect: 'error',
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body };
};
