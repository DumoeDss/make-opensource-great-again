/**
 * Deterministic terminal-manifest renderer.
 *
 * Produces the sole terminal user message: a short `ACK`-only preamble followed
 * by a `<mosga-session-context>` JSON block. The renderer is a PURE function —
 * it accepts only its explicit typed inputs, performs no filesystem, network, or
 * session-file access, and adds NO data that is not in its explicit inputs.
 *
 * Determinism: identical inputs always produce byte-identical output (canonical
 * JSON key order via recursive sort, LF line endings, no trailing whitespace).
 */
import type {
  CliResumeConsent,
  ReplayOmission,
  TerminalManifestSeed,
} from '@mosga/contracts';

/**
 * Inputs to the terminal-manifest renderer. Every field comes from either the
 * sealed bundle (seed, omissions, humanReviewPassed, bundleContentHash) or the
 * runtime observation (replayCliVersion) or the validated consent — never from a
 * raw-session reread.
 */
export interface RenderTerminalManifestInput {
  readonly seed: TerminalManifestSeed;
  readonly omissions: readonly ReplayOmission[];
  readonly humanReviewPassed: boolean;
  readonly bundleContentHash: `sha256:${string}`;
  readonly replayCliVersion: string;
  readonly consent: CliResumeConsent;
}

/**
 * Render the terminal user message deterministically.
 *
 * The output format is:
 * ```
 * Reply with ACK only — this context is for your awareness; do not act on it.
 *
 * <mosga-session-context>
 * {canonical JSON}
 * </mosga-session-context>
 * ```
 */
export function renderTerminalManifest(
  input: RenderTerminalManifestInput,
): string {
  const block = buildManifestBlock(input);
  const json = canonicalStringify(block);
  return (
    'Reply with ACK only — this context is for your awareness; do not act on it.\n' +
    '<mosga-session-context>\n' +
    json +
    '\n</mosga-session-context>'
  );
}

// -----------------------------------------------------------------------
// Internal: build the manifest block from the inputs.
// -----------------------------------------------------------------------

interface ManifestBlock {
  readonly [key: string]: unknown;
}

function buildManifestBlock(input: RenderTerminalManifestInput): ManifestBlock {
  const { seed, omissions, humanReviewPassed, bundleContentHash, replayCliVersion, consent } = input;

  return {
    kind: seed.kind,
    schemaVersion: seed.schemaVersion,
    purpose: seed.purpose,
    source: {
      ...seed.source,
      replayCliVersion,
    },
    trajectory: {
      ...seed.trajectory,
      omissions: omissions.map((omission) => ({
        id: omission.id,
        category: omission.category,
        reason: omission.reason,
        disclosure: omission.disclosure,
      })),
    },
    sanitization: {
      ...seed.sanitization,
      humanReviewPassed,
      bundleContentHash,
    },
    runtime: {
      replayMode: seed.replayMode,
      instructionPolicy: seed.instructionPolicy,
      skillPolicy: seed.skillPolicy,
      proxyRescan: seed.proxyRescan,
      maxInferenceRequests: seed.maxInferenceRequests,
    },
    delivery: {
      targetProviderId: seed.delivery.targetProviderId,
      targetModel: seed.delivery.targetModel,
    },
    consent: {
      consentVersion: consent.consentVersion,
      tosRiskAcknowledged: consent.tosRiskAcknowledged,
      fullRetentionAcknowledged: consent.fullRetentionAcknowledged,
      runtimeContextAcknowledged: consent.runtimeContextAcknowledged,
      confirmedAt: consent.confirmedAt,
    },
  };
}

// -----------------------------------------------------------------------
// Internal: canonical JSON serialization (recursive key sort, compact).
// -----------------------------------------------------------------------

/**
 * Produce a canonical JSON string: all object keys sorted lexicographically at
 * every depth, compact (no whitespace between tokens), ensuring byte-identical
 * output for structurally identical inputs regardless of construction order.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = canonicalize(record[key]);
  }
  return sorted;
}
