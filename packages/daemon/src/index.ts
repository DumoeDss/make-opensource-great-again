// Public surface of @mosga/daemon: the app factory, server lifecycle, and the
// review store + envelope/whitelist helpers slice 4 and tests build on.
export { createApp, type App, type AppOptions } from './app.js';
export {
  startDaemon,
  type DaemonOptions,
  type RunningDaemon,
  LOOPBACK_HOST,
  DEFAULT_PORT,
} from './server.js';
export { ReviewStore, type ReviewState } from './reviews.js';
export {
  createProviderStore,
  createInMemoryProviderStore,
  ProviderConflictError,
  type ProviderStore,
  type ProviderStoreOptions,
  type KeyStatus,
} from './providerStore.js';
export { buildEnvelope, TOOL_VERSION, SCHEMA_VERSION } from './envelope.js';
export {
  annotateProject,
  type ProjectAnnotation,
  readFirstRemoteUrl,
  remoteHost,
} from './whitelist.js';
export { resolveUiDist } from './staticUi.js';
