import type { SubmissionUsage } from '@mosga/contracts';

/**
 * The exact outbound HTTP request. `body` is the literal serialized bytes the
 * backstop already scanned; `headers` is the ONLY place the API key appears (as
 * the authorization header) — never in `body`.
 */
export interface OutboundRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface OutboundResult {
  status: number;
  /** Normalized token usage parsed from the provider response, if present. */
  usage: SubmissionUsage | null;
}

/**
 * Injectable HTTP boundary. The completion body is discarded (ingestion only);
 * only status + usage are returned. Tests inject a mock so no real network call
 * and no real key are ever used.
 */
export type Transport = (req: OutboundRequest) => Promise<OutboundResult>;

/** Parse usage from either an Anthropic or an OpenAI completion response body. */
function parseUsage(json: unknown): SubmissionUsage | null {
  if (!json || typeof json !== 'object') return null;
  const usage = (json as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  if (typeof input === 'number' && typeof output === 'number') {
    return { inputTokens: input, outputTokens: output };
  }
  return null;
}

/**
 * The default `fetch`-based transport. Sends the exact bytes, discards the
 * completion, and extracts usage. This is the ONLY code path that touches the
 * network; it is never exercised by tests (which inject a mock transport).
 */
export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  let usage: SubmissionUsage | null = null;
  try {
    usage = parseUsage(await res.json());
  } catch {
    // A non-JSON / empty body is fine — ingestion does not need the completion.
  }
  return { status: res.status, usage };
};
