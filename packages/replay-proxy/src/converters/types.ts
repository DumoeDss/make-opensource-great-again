import type { ReplayApiFormat, ReplaySourceWireProtocol } from '../types.js';

/**
 * Internal converter contracts. These are NOT exported from the package surface
 * — the surface test asserts only the high-level proxy factory is reachable.
 *
 * A converter receives the raw CLI request body as bytes and returns the
 * converted outbound body as bytes plus the target path and the auth scheme the
 * target expects. It NEVER receives the route token, the real API key, the
 * bundle, or the workspace path; the transport layer attaches the real
 * authorization header from the non-exported route record. Converters perform
 * purely structural protocol mapping and never scan, sanitize, rewrite,
 * truncate, or summarize content.
 */
export interface ReplayConversionContext {
  readonly sourceProtocol: ReplaySourceWireProtocol;
  readonly targetFormat: ReplayApiFormat;
  readonly upstreamBaseUrl: string;
  readonly upstreamModel: string;
  readonly cliModel: string;
  /** Whether the CLI's request body asked for a streaming response. */
  readonly streamingRequested: boolean;
}

/**
 * The authorization header scheme the target provider expects. The transport
 * layer constructs the actual header value from the route record's real key:
 *
 * - `x-api-key` → `x-api-key: <realKey>` (Anthropic).
 * - `bearer` → `Authorization: Bearer <realKey>` (OpenAI family).
 */
export type ReplayAuthScheme = 'x-api-key' | 'bearer';

export interface ReplayConvertedRequest {
  /** Path appended to `upstreamBaseUrl` (e.g. `/v1/messages`). */
  readonly targetPath: string;
  readonly authScheme: ReplayAuthScheme;
  /** Non-authorization headers (content-type, api version, etc.). */
  readonly headers: Record<string, string>;
  /** Converted outbound body bytes (post-conversion, pre-transport). */
  readonly body: Uint8Array;
}

export interface ReplayProtocolConverter {
  readonly id: string;
  readonly version: string;
  readonly sourceProtocol: ReplaySourceWireProtocol;
  readonly targetFormat: ReplayApiFormat;
  convertRequest(
    cliRequestBody: Uint8Array,
    context: ReplayConversionContext,
  ): ReplayConvertedRequest;
  convertResponse(
    upstreamResponseBody: Uint8Array,
    context: ReplayConversionContext,
  ): Uint8Array;
}

/**
 * Thrown by a converter when it cannot structurally map a required field to the
 * target protocol. The route classifies this as `converter-request-failed` (or
 * `converter-response-failed` for response conversion) rather than silently
 * dropping the field.
 */
export class ConverterUnsupportedFieldError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConverterUnsupportedFieldError';
  }
}
