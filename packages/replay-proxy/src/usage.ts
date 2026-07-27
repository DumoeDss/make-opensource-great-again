import type { SubmissionUsage } from '@mosga/contracts';

import type { ReplayApiFormat } from './types.js';

/**
 * Parse normalized `{ inputTokens, outputTokens }` usage from an upstream
 * response body across the three supported provider shapes:
 *
 * - Anthropic Messages: `usage.input_tokens` / `usage.output_tokens`.
 * - OpenAI Chat Completions: `usage.prompt_tokens` / `usage.completion_tokens`.
 * - OpenAI Responses: `usage.input_tokens` / `usage.output_tokens`.
 *
 * Returns `null` if the body is not valid JSON or carries no recognizable usage
 * object. The proxy never lets a usage-parse failure fail the round-trip; the
 * receipt simply records `usage: null`.
 */
export function parseUsage(
  responseBody: Uint8Array,
  format: ReplayApiFormat,
): SubmissionUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(responseBody).toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const usage = (parsed as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;

  const inputTokens = readNonNegativeInt(
    format === 'openai-chat-completions' ? u.prompt_tokens : u.input_tokens,
  );
  const outputTokens = readNonNegativeInt(
    format === 'openai-chat-completions'
      ? u.completion_tokens
      : u.output_tokens,
  );
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}
