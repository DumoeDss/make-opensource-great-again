/**
 * @mosga/daemon/secrets — the AES-256-GCM secret-envelope stack, ported
 * file-level from omnicross (MIT, same author): a pure envelope codec, the
 * 32-byte master-key resolver, and the tri-state `SecretBox`. Used to encrypt
 * provider API keys at rest in the user-scope key store.
 */
export {
  ENVELOPE_PREFIX,
  encryptValue,
  decryptValue,
  isEnvelope,
  parseEnvelope,
  type ParsedEnvelope,
} from './envelope.js';

export {
  MASTER_KEY_ENV,
  resolveMasterKey,
  defaultMasterKeyPath,
  type ResolveMasterKeyOptions,
} from './masterKey.js';

export { SecretBox, type MasterKeyInput } from './SecretBox.js';
