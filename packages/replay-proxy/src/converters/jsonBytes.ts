/**
 * Parse a JSON byte body to a value of unknown shape. Throws a
 * `ConverterUnsupportedFieldError` (re-classified as `converter-*-failed` by the
 * route) when the body is not valid JSON — the proxy never silently skips a
 * malformed body.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`body is not valid JSON: ${(cause as Error).message}`);
  }
}

/** Serialize a value to UTF-8 JSON bytes with stable key ordering. */
export function encodeJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}
