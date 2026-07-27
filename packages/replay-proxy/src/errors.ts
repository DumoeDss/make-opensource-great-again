import type {
  ReplayProxyErrorCode,
  ReplayProxyFailure,
  ReplayProxyStage,
  ReplayRouteClosedState,
} from './types.js';

/**
 * Construct a disclosure-safe failure. The failure carries only stable
 * identifiers; the raw cause is captured here solely to be swallowed — never
 * surfaced, logged with detail, or relayed.
 */
export function failure(
  code: ReplayProxyErrorCode,
  stage: ReplayProxyStage,
  routeClosed: ReplayRouteClosedState,
): ReplayProxyFailure {
  return { code, stage, routeClosed };
}

/**
 * A generic JSON error body returned to the CLI over loopback. The body carries
 * a stable `type` string only — no route, target, key, token, or body detail.
 * The CLI can parse it in its own wire protocol and exit cleanly.
 */
export function cliErrorBody(type: ReplayCliErrorType): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      error: {
        type,
        message: GENERIC_MESSAGE,
      },
    }),
    'utf8',
  );
}

export type ReplayCliErrorType =
  | 'mosga_route_already_used'
  | 'mosga_route_token_invalid'
  | 'mosga_converter_failed'
  | 'mosga_upstream_failed'
  | 'mosga_route_disposed'
  | 'mosga_request_too_large'
  | 'mosga_internal_error';

const GENERIC_MESSAGE =
  'The MOSGA replay proxy could not service this request.';

export const CLI_ERROR_TYPES = {
  alreadyUsed: 'mosga_route_already_used' as const,
  tokenInvalid: 'mosga_route_token_invalid' as const,
  converterFailed: 'mosga_converter_failed' as const,
  upstreamFailed: 'mosga_upstream_failed' as const,
  routeDisposed: 'mosga_route_disposed' as const,
  requestTooLarge: 'mosga_request_too_large' as const,
  internalError: 'mosga_internal_error' as const,
};
