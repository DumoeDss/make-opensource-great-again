import type { ReplayMode, SanitizedSession } from '@mosga/contracts';

import { serializeMeta, toAnthropicMessages, type MetaVersions, buildMetaMessage } from './reconstruct.js';

/**
 * Representative open-model pricing (DeepSeek-class), USD per token. The
 * DETERMINISTIC token count is the authoritative output; cost is an
 * approximation the contributor verifies at consent time (provider pricing
 * drifts). Overridable for a specific provider/model.
 */
export interface Pricing {
  inputPerToken: number;
  outputPerToken: number;
}

export const DEFAULT_PRICING: Pricing = {
  inputPerToken: 0.28 / 1_000_000,
  outputPerToken: 0.42 / 1_000_000,
};

/**
 * Curated per-provider pricing (USD/token). The `@omnicross/contracts` presets
 * carry no per-token price sheet, so pricing lives here, keyed by provider id.
 * Anything absent falls back to `DEFAULT_PRICING` — surfaced as `pricingSource`
 * so the contributor knows whether the cost figure is provider-specific or a
 * generic estimate. Verify against the live price sheet; provider pricing drifts.
 */
export const PROVIDER_PRICING: Record<string, Pricing> = {
  deepseek: { inputPerToken: 0.28 / 1_000_000, outputPerToken: 0.42 / 1_000_000 },
};

export type PricingSource = 'provider' | 'default';

/** Resolve pricing for a provider id, disclosing whether it is provider-specific. */
export function resolveProviderPricing(providerId?: string): {
  pricing: Pricing;
  pricingSource: PricingSource;
} {
  const p = providerId ? PROVIDER_PRICING[providerId] : undefined;
  return p ? { pricing: p, pricingSource: 'provider' } : { pricing: DEFAULT_PRICING, pricingSource: 'default' };
}

/** Representative single throwaway-generation output size (tokens). */
const OUTPUT_TOKENS_PER_GENERATION = 800;

/** Rough token count: ~4 chars/token. A conservative over-estimate for gating. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Per-message input-token estimate over the reconstructed Anthropic content. */
function perMessageTokens(session: SanitizedSession): number[] {
  const conv = toAnthropicMessages(session);
  const tokens = conv.messages.map((m) => estimateTokens(JSON.stringify(m.content)));
  if (conv.system) tokens.unshift(estimateTokens(conv.system));
  return tokens;
}

export interface Estimate {
  replayMode: ReplayMode;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 1 for single-shot; the number of prefix requests for turn-by-turn. */
  requestCount: number;
  estimatedCostUsd: number;
}

/**
 * Estimate token cost for a session against a mode WITHOUT sending. Single-shot
 * is linear (whole conversation + meta in one request); turn-by-turn is
 * quadratic in turn count (Σ of growing prefixes) — see the change design's
 * measured cost table. `metaVersions` lets the estimate include the meta turn's
 * tokens; when omitted, a small fixed allowance is used.
 */
export function estimate(
  session: SanitizedSession,
  replayMode: ReplayMode,
  options: { pricing?: Pricing; metaVersions?: MetaVersions } = {},
): Estimate {
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const msgTokens = perMessageTokens(session);

  // Meta turn tokens. Build a representative meta payload when versions are
  // available; otherwise a conservative fixed allowance.
  let metaTokens = 512;
  if (options.metaVersions) {
    const meta = buildMetaMessage(
      session,
      {
        consentVersion: '0.2.0',
        tosRiskAcknowledged: true,
        fullRetentionAcknowledged: true,
        targetProviderId: '',
        targetModel: '',
        replayMode,
        estimatedTokens: 0,
        contentHash: '',
        confirmedAt: '',
      },
      options.metaVersions,
    );
    metaTokens = estimateTokens(serializeMeta(meta));
  }

  if (replayMode === 'single-shot') {
    const inputTokens = msgTokens.reduce((a, b) => a + b, 0) + metaTokens;
    const outputTokens = OUTPUT_TOKENS_PER_GENERATION;
    const estimatedCostUsd =
      inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken;
    return {
      replayMode,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      requestCount: 1,
      estimatedCostUsd,
    };
  }

  // turn-by-turn: re-post the growing prefix once per turn (quadratic).
  let inputTokens = 0;
  let prefix = 0;
  let requestCount = 0;
  for (const t of msgTokens) {
    prefix += t;
    inputTokens += prefix;
    requestCount += 1;
  }
  // Final ingestion request carries the meta turn.
  inputTokens += msgTokens.reduce((a, b) => a + b, 0) + metaTokens;
  requestCount += 1;
  const outputTokens = requestCount * OUTPUT_TOKENS_PER_GENERATION;
  const estimatedCostUsd =
    inputTokens * pricing.inputPerToken + outputTokens * pricing.outputPerToken;
  return {
    replayMode,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requestCount,
    estimatedCostUsd,
  };
}
