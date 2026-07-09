/**
 * @mosga/direct-submit — 出口② replay engine. Consumes a gate-unlocked, stamped
 * `SanitizedSession` and replays it to a user-chosen open-model provider using
 * the contributor's own key: request reconstruction + Anthropic/OpenAI
 * conversion, a pre-send raw-bytes backstop (replicating the publisher pattern),
 * an informed-consent gate bound to content by hash, token-cost estimation, and
 * a key-free submission receipt.
 */
export {
  toAnthropicMessages,
  buildAnthropicRequest,
  buildMetaMessage,
  foldThinkingIntoText,
  serializeMeta,
  META_VERSION,
  type MetaVersions,
  type ReconstructedConversation,
  type BuildRequestOptions,
} from './reconstruct.js';

export {
  scanOutboundBytesBackstop,
  assertOutboundClean,
  SubmissionRefusedError,
} from './backstop.js';

export { computeContentHash, assertConsent, ConsentError } from './consent.js';

export {
  listProviders,
  resolveProvider,
  isAnthropicFormat,
  ALLOWED_PRESET_IDS,
  type ProviderTarget,
  type UserTarget,
} from './providers.js';

export { resolveProviderKey, KeyNotConfiguredError, type KeyResolutionOptions } from './keys.js';

export {
  estimate,
  DEFAULT_PRICING,
  PROVIDER_PRICING,
  resolveProviderPricing,
  type Estimate,
  type Pricing,
  type PricingSource,
} from './estimate.js';

export {
  fetchTransport,
  type Transport,
  type OutboundRequest,
  type OutboundResult,
} from './transport.js';

export { submit, NotStampedError, type SubmitParams } from './submit.js';

export { resolvePackageVersion } from './version.js';
export { resolveMetaVersions } from './versions.js';
