import { buildV1Registry, ConverterRegistry } from './registry.js';
import { anthropicPassthroughV1, openaiResponsesPassthroughV1 } from './passthrough.js';
import { anthropicToOpenaiChatV1 } from './anthropicToChat.js';
import { openaiResponsesToOpenaiChatV1 } from './responsesToChat.js';

export { ConverterRegistry, buildV1Registry } from './registry.js';
export { anthropicPassthroughV1, openaiResponsesPassthroughV1 } from './passthrough.js';
export { anthropicToOpenaiChatV1 } from './anthropicToChat.js';
export { openaiResponsesToOpenaiChatV1 } from './responsesToChat.js';
export { synthesizeStream } from './streaming.js';
export { ConverterUnsupportedFieldError } from './types.js';
export type {
  ReplayAuthScheme,
  ReplayConversionContext,
  ReplayConvertedRequest,
  ReplayProtocolConverter,
} from './types.js';

/**
 * The exact v1 converter set: two passthrough converters plus two
 * cross-protocol converters to OpenAI Chat Completions. Every other
 * `(sourceProtocol, targetFormat)` pair fails closed at registration.
 */
export const V1_CONVERTERS = [
  anthropicPassthroughV1,
  openaiResponsesPassthroughV1,
  anthropicToOpenaiChatV1,
  openaiResponsesToOpenaiChatV1,
] as const;

/** Build the v1 converter registry used by every `createReplayProxy` instance. */
export function createV1ConverterRegistry(): ConverterRegistry {
  return buildV1Registry(V1_CONVERTERS);
}
