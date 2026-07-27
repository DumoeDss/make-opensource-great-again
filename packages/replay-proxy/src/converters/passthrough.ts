import type { ReplayConvertedRequest, ReplayProtocolConverter } from './types.js';

/**
 * `anthropic-passthrough-v1`: Claude route -> Anthropic-native upstream. Near
 * identity: the request body passes through byte-for-byte (the authorization
 * header is rewritten from the route token to the real key by the transport
 * layer, and the converter declares the `x-api-key` scheme and the
 * `anthropic-version` header). Response body passes through unchanged.
 *
 * Because the body is untouched, `cliRequestHash` and `outboundRequestHash` for
 * a passthrough round-trip are byte-equal.
 */
export const anthropicPassthroughV1: ReplayProtocolConverter = {
  id: 'anthropic-passthrough-v1',
  version: '1.0.0',
  sourceProtocol: 'anthropic-messages',
  targetFormat: 'anthropic-messages',
  convertRequest(cliRequestBody, context): ReplayConvertedRequest {
    return {
      targetPath: '/v1/messages',
      authScheme: 'x-api-key',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': readAnthropicVersion(cliRequestBody),
      },
      body: cliRequestBody,
    };
  },
  convertResponse(upstreamResponseBody): Uint8Array {
    return upstreamResponseBody;
  },
};

/**
 * `openai-responses-passthrough-v1`: Codex route -> OpenAI Responses-native
 * upstream. Near identity: body passes through unchanged; the converter declares
 * the `bearer` scheme.
 */
export const openaiResponsesPassthroughV1: ReplayProtocolConverter = {
  id: 'openai-responses-passthrough-v1',
  version: '1.0.0',
  sourceProtocol: 'openai-responses',
  targetFormat: 'openai-responses',
  convertRequest(cliRequestBody): ReplayConvertedRequest {
    return {
      targetPath: '/v1/responses',
      authScheme: 'bearer',
      headers: {
        'content-type': 'application/json',
      },
      body: cliRequestBody,
    };
  },
  convertResponse(upstreamResponseBody): Uint8Array {
    return upstreamResponseBody;
  },
};

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * The CLI's own request body sometimes carries an `anthropic_version`-like
 * hint, but the transport-level header is what the upstream validates. We use
 * the stable default unless a future CLI negotiation requires otherwise; this
 * default matches the public Anthropic Messages API version.
 */
function readAnthropicVersion(_cliRequestBody: Uint8Array): string {
  return DEFAULT_ANTHROPIC_VERSION;
}
