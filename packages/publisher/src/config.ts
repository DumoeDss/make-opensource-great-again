import { readFileSync } from 'node:fs';

/**
 * Load custom rules (Layer 2) from a TRUSTED, locally-configured JSON path —
 * never from the artifact or a request body. This mirrors the daemon's
 * deliberate removal of a client-supplied custom-rules path: accepting an
 * artifact-embedded path would be an arbitrary file read. Returns `[]` when
 * unset. A malformed/unreadable file throws — a local config error the operator
 * sees, not something reachable from published bytes.
 */
export function loadTrustedCustomRules(customRulesPath: string | undefined): unknown[] {
  if (!customRulesPath) return [];
  const raw = readFileSync(customRulesPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}
