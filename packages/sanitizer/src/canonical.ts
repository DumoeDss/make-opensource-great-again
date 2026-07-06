/**
 * Canonical JSON serialization for `toolCalls[].input` scanning (design D5).
 *
 * Keys are emitted in sorted order so a hit's char span is deterministic and an
 * apply pass can re-serialize identically, edit the span, and re-parse back into
 * the `input` object. Uses 2-space indentation to match `JSON.stringify` round
 * trips readably; the exact formatting only needs to be STABLE, not canonical in
 * any external sense.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
