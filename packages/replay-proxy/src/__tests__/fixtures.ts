import type { ReplayRouteRequirement } from '@mosga/replay-runtime';

import type {
  ReplayOutboundRequest,
  ReplayProxyReceipt,
  ReplayUpstreamResponse,
  ReplayUpstreamTarget,
  ReplayUpstreamTransport,
} from '../types.js';

// ---------------------------------------------------------------------------
// Sealed fake route requirements + upstream targets.
// ---------------------------------------------------------------------------

export const CLAUDE_REQUIREMENT: ReplayRouteRequirement = {
  sourceCli: 'claude-code',
  wireProtocol: 'anthropic-messages',
  transport: 'loopback-http',
  authScheme: 'route-bearer',
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
};

export const CODEX_REQUIREMENT: ReplayRouteRequirement = {
  sourceCli: 'codex',
  wireProtocol: 'openai-responses',
  transport: 'loopback-http',
  authScheme: 'route-bearer',
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
};

export const CLAUDE_TARGET_ANTHROPIC: ReplayUpstreamTarget = {
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
  upstreamBaseUrl: 'https://api.anthropic.example',
  upstreamApiKey: 'sk-test-ANTHROPIC-key-CANARY',
  upstreamApiFormat: 'anthropic-messages',
};

export const CLAUDE_TARGET_CHAT: ReplayUpstreamTarget = {
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
  upstreamBaseUrl: 'https://api.openai.example',
  upstreamApiKey: 'sk-test-OPENAI-key-CANARY',
  upstreamApiFormat: 'openai-chat-completions',
};

export const CODEX_TARGET_RESPONSES: ReplayUpstreamTarget = {
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
  upstreamBaseUrl: 'https://api.openai.example',
  upstreamApiKey: 'sk-test-OPENAI-key-CANARY',
  upstreamApiFormat: 'openai-responses',
};

export const CODEX_TARGET_CHAT: ReplayUpstreamTarget = {
  targetProviderId: 'openai',
  targetModel: 'gpt-4o',
  upstreamBaseUrl: 'https://api.openai.example',
  upstreamApiKey: 'sk-test-OPENAI-key-CANARY',
  upstreamApiFormat: 'openai-chat-completions',
};

// ---------------------------------------------------------------------------
// Sample CLI request bodies (what the resumed CLI would assemble).
// ---------------------------------------------------------------------------

export const ANTHROPIC_REQUEST_BODY = {
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 256,
  system: 'CANARY-SYSTEM-PROMPT-anthropic',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'CANARY-USER-MESSAGE-anthropic' },
      ],
    },
  ],
  tools: [
    {
      name: 'CANARY-TOOL',
      description: 'CANARY-TOOL-DESC',
      input_schema: { type: 'object', properties: { x: { type: 'string' } } },
    },
  ],
  stream: false,
};

export const ANTHROPIC_STREAMING_REQUEST_BODY = {
  ...ANTHROPIC_REQUEST_BODY,
  stream: true,
};

export const RESPONSES_REQUEST_BODY = {
  model: 'codex-mini',
  instructions: 'CANARY-INSTRUCTIONS-responses',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'CANARY-USER-MESSAGE-responses' }],
    },
  ],
  tools: [
    {
      type: 'function',
      name: 'CANARY-TOOL',
      description: 'CANARY-TOOL-DESC',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    },
  ],
  stream: false,
};

// ---------------------------------------------------------------------------
// Sample upstream responses (what the provider returns).
// ---------------------------------------------------------------------------

export const CHAT_RESPONSE_BODY = {
  id: 'chatcmpl-canary',
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'CANARY-ASSISTANT-TEXT',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
};

export const ANTHROPIC_RESPONSE_BODY = {
  id: 'msg_canary',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-5-sonnet-20241022',
  content: [{ type: 'text', text: 'CANARY-ASSISTANT-TEXT' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 42, output_tokens: 7 },
};

export const RESPONSES_RESPONSE_BODY = {
  id: 'resp_canary',
  object: 'response',
  status: 'completed',
  model: 'gpt-4o',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'CANARY-ASSISTANT-TEXT', annotations: [] }],
    },
  ],
  usage: { input_tokens: 42, output_tokens: 7 },
};

// ---------------------------------------------------------------------------
// Fake upstream transport — records the outbound request, returns canned.
// ---------------------------------------------------------------------------

export interface RecordedTransport {
  readonly transport: ReplayUpstreamTransport;
  readonly requests: ReplayOutboundRequest[];
  readonly setResponse: (response: ReplayUpstreamResponse) => void;
  readonly setThrow: (err: Error) => void;
}

export function createRecordingTransport(
  defaultResponse: ReplayUpstreamResponse,
): RecordedTransport {
  const requests: ReplayOutboundRequest[] = [];
  let nextResponse: ReplayUpstreamResponse = defaultResponse;
  let throwErr: Error | null = null;
  const transport: ReplayUpstreamTransport = async (request) => {
    requests.push(request);
    if (throwErr) throw throwErr;
    return nextResponse;
  };
  return {
    transport,
    requests,
    setResponse: (response) => {
      nextResponse = response;
    },
    setThrow: (err) => {
      throwErr = err;
    },
  };
}

export function jsonResponse(status: number, body: unknown): ReplayUpstreamResponse {
  return {
    status,
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

// ---------------------------------------------------------------------------
// HTTP client helper — drives a real loopback request against the proxy.
// ---------------------------------------------------------------------------

export interface ProxyResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

export async function postToProxy(
  baseUrl: string,
  routeToken: string,
  body: unknown,
  options: { readonly authorization?: string; readonly rawBody?: Uint8Array } = {},
): Promise<ProxyResponse> {
  const bodyBytes =
    options.rawBody ?? Buffer.from(JSON.stringify(body), 'utf8');
  const auth =
    options.authorization === undefined
      ? `Bearer ${routeToken}`
      : options.authorization;
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    body: bodyBytes,
    // Do not follow redirects — the proxy never redirects.
    redirect: 'manual',
  });
  const text = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, body: text, headers };
}

/** Await the receipt, catching rejections so the test can inspect the failure. */
export async function awaitReceipt(
  receipt: Promise<ReplayProxyReceipt>,
): Promise<{ ok: true; receipt: ReplayProxyReceipt } | { ok: false; error: unknown }> {
  try {
    const r = await receipt;
    return { ok: true, receipt: r };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Encode a JSON body to bytes (for hash assertions). */
export function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}
