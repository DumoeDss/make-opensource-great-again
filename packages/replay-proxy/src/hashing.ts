import { createHash } from 'node:crypto';

/**
 * SHA-256 of the exact bytes, formatted `sha256:<lowercase-hex>` to match the
 * bundle's domain-separated digest format. Used for both the raw CLI request
 * body (before conversion) and the converted outbound body (after conversion).
 * For a passthrough converter the two inputs are identical, so the hashes are
 * equal — proving the body was not altered in transit.
 */
export function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
  const hash = createHash('sha256');
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}` as `sha256:${string}`;
}
