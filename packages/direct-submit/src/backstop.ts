import type { SanitizedSession } from '@mosga/contracts';
import { type CompiledRuleset, type Finding, scanSession } from '@mosga/sanitizer';

/**
 * Pre-send raw-bytes backstop for 出口② (slice-1 inheritance). This REPLICATES
 * the publisher's `scanRawBytesBackstop` PATTERN and deliberately does NOT import
 * from or modify `packages/publisher/src/precheck.ts` (a slice-1 invariant, and
 * that function is not exported anyway). Duplication of ~30 lines is accepted to
 * keep the two exits decoupled.
 *
 * The structured `scanSession` only visits a subset of fields; here we run the
 * SAME compiled ruleset directly over the EXACT serialized outbound bytes (the
 * converted request plus the meta message — the literal bytes leaving the
 * machine) as a synthetic field, so any blocking hit ANYWHERE in the outbound
 * bytes refuses the send. The bytes are scanned in overlapping windows to avoid
 * truncation on a large request (which would trip a spurious `redos-guard`).
 */

// Each window stays under the sanitizer's per-field 200k scan cap; the overlap
// catches a secret straddling a window boundary. Same sizing as the publisher.
const RAW_SCAN_WINDOW = 100_000;
const RAW_SCAN_OVERLAP = 4_096;

/** Wrap arbitrary text as the sole scannable field of a synthetic session. */
function syntheticSession(text: string): SanitizedSession {
  return {
    schemaVersion: 'raw-backstop',
    meta: {
      contributorAlias: '',
      sourceCli: 'claude-code',
      toolVersion: '',
      sanitizationRulesetVersion: null,
      exportedAt: '',
      license: null,
      sanitized: false,
    },
    session: { sessionId: '', sourceId: '', projectKey: '', cwd: null, title: null, updatedAt: 0 },
    messages: [
      { sdkUuid: 'raw', parentUuid: null, role: 'user', content: text, sdkMessageType: 'message', timestamp: 0 },
    ],
  };
}

/**
 * Scan the exact outbound bytes and return the surviving Layer-1/2 blocking
 * findings (`secrets`, `custom`, `redos-guard`, `ruleset-compile-error`).
 * Layer-3 `normalization` findings are non-blocking and never returned (mirrors
 * the gate/publisher semantics). An empty result means a clean pass.
 */
export function scanOutboundBytesBackstop(
  rawBytes: string,
  ruleset: CompiledRuleset,
  generatedAt?: string,
): Finding[] {
  const found: Finding[] = [];
  const seen = new Set<string>();
  const step = RAW_SCAN_WINDOW - RAW_SCAN_OVERLAP;
  for (let start = 0; start === 0 || start < rawBytes.length; start += step) {
    const chunk = rawBytes.slice(start, start + RAW_SCAN_WINDOW);
    const { report } = scanSession(syntheticSession(chunk), ruleset, { generatedAt });
    for (const f of report.findings) {
      if (!f.blocking) continue;
      const key = `${f.ruleId} ${f.matchPreview}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (start + RAW_SCAN_WINDOW >= rawBytes.length) break;
  }
  return found;
}

/**
 * Raised when the pre-send backstop finds a surviving blocking finding in the
 * exact bytes about to be sent. There is NO allow-escape at this layer — a
 * secret a human mistakenly `allow`ed, or one reintroduced by format conversion
 * or the meta message, still refuses the send. No bytes reach the provider.
 */
export class SubmissionRefusedError extends Error {
  readonly blockingFindings: Finding[];
  constructor(blockingFindings: Finding[]) {
    const unique = [...new Set(blockingFindings.map((f) => f.ruleId))];
    super(
      `submission refused: the pre-send backstop found ${blockingFindings.length} surviving blocking ` +
        `finding(s) [${unique.join(', ')}] in the outbound bytes; nothing was sent. ` +
        `Remove/replace the value or allowlist the rule upstream, then re-run.`,
    );
    this.name = 'SubmissionRefusedError';
    this.blockingFindings = blockingFindings;
  }
}

/** Scan the outbound bytes and throw `SubmissionRefusedError` on any blocking hit. */
export function assertOutboundClean(
  rawBytes: string,
  ruleset: CompiledRuleset,
  generatedAt?: string,
): void {
  const blocking = scanOutboundBytesBackstop(rawBytes, ruleset, generatedAt);
  if (blocking.length > 0) throw new SubmissionRefusedError(blocking);
}
