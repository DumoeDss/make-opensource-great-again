/**
 * Redact a matched secret into a SAFE-to-display preview (design D7 / Risks).
 *
 * The `SanitizationReport` is persisted and rendered by slice 3; it must never
 * itself become a leak. The raw match lives only in the in-memory apply pass.
 * We keep at most the first/last 2 chars plus the length so a reviewer can tell
 * two hits apart without exposing the secret. Short values are fully masked.
 */
export function redactPreview(raw: string): string {
  const len = raw.length;
  if (len <= 8) return `${'•'.repeat(len)} (len ${len})`;
  return `${raw.slice(0, 2)}${'•'.repeat(4)}${raw.slice(-2)} (len ${len})`;
}
