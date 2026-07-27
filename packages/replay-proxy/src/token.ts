import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The route token is placed ONLY in `ReplayRouteBinding.routeToken` and the
 * proxy's non-exported route record. It is never logged, persisted, sent to the
 * upstream, included in a receipt, or returned in an error response.
 *
 * The default random source is `node:crypto.randomBytes`; tests inject a fake to
 * drive the validation canaries deterministically.
 */
export function generateRouteToken(
  randomSource: (byteLength: number) => Uint8Array = randomBytes,
): string {
  const bytes = randomSource(32);
  if (bytes.byteLength < 32) {
    throw new Error(
      'route token random source must return at least 32 bytes of entropy',
    );
  }
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Constant-time comparison of the presented token against the route record's
 * token. A missing, malformed, or mismatched token yields `false`; the caller
 * classifies the result as `route-token-invalid` (HTTP 401).
 */
export function validateRouteToken(
  presented: string | undefined,
  expected: string,
): boolean {
  if (typeof presented !== 'string' || presented.length === 0) {
    return false;
  }
  const presentedBuffer = Buffer.from(presented);
  const expectedBuffer = Buffer.from(expected);
  if (presentedBuffer.byteLength !== expectedBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(presentedBuffer, expectedBuffer);
}

/**
 * Extract the bearer credential from an HTTP Authorization header value. The
 * route accepts `Authorization: Bearer <token>`. Returns `undefined` for any
 * other shape so the caller classifies it as `route-token-invalid`.
 */
export function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(authorizationHeader)) {
    if (authorizationHeader.length === 0) return undefined;
    return extractBearerToken(authorizationHeader[0]);
  }
  if (typeof authorizationHeader !== 'string') return undefined;
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match ? match[1].trim() : undefined;
}
