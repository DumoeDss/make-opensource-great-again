import type { CapabilityProfile } from './adapters/types.js';
import type { ValidatedReplayInput } from './validated.js';
import type {
  ReplayRouteRequirement,
} from './types.js';

/**
 * Build the immutable route requirement (the contract the execute-time route
 * binding must satisfy). Read once from the validated bundle + profile.
 */
export function createRouteRequirement(
  validated: ValidatedReplayInput,
  profile: CapabilityProfile,
): ReplayRouteRequirement {
  return Object.freeze({
    sourceCli: profile.sourceCli,
    wireProtocol: profile.wireProtocol,
    transport: 'loopback-http',
    authScheme: 'route-bearer',
    targetProviderId:
      validated.payload.delivery.targetProviderId,
    targetModel: validated.payload.delivery.targetModel,
  });
}

/**
 * Loopback host check. Shared with the owned-snapshot capture path so the
 * validation rule has exactly one definition.
 */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]'
  );
}

/**
 * Unpaired-surrogate check. Shared with the owned-snapshot capture path.
 */
export function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        !Number.isFinite(next) ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// The validateRouteBinding / encodeTerminalInput helpers previously here have
// been replaced by the read-once owned-snapshot capture path in
// `ownedLaunchSnapshot.ts` (captureOwnedRoute / captureOwnedTerminal). The
// caller's route / terminalInput are now read exactly once and frozen, closing
// the STD-B1 check/use gap. The helpers above (loopback / surrogate) remain
// the single source of truth for those validation rules.
