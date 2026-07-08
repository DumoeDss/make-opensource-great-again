import { createHash } from 'node:crypto';

import type { ContributionConsent, SanitizedSession } from '@mosga/contracts';
import { canonicalJson } from '@mosga/sanitizer';

/**
 * sha256 of the canonicalized stamped session. Consent is bound to this exact
 * content: the submitter recomputes it and refuses when it does not match the
 * hash the user confirmed against (consent given for different content).
 */
export function computeContentHash(session: SanitizedSession): string {
  return createHash('sha256').update(canonicalJson(session)).digest('hex');
}

/**
 * Raised when the informed-consent gate refuses a send: consent absent, either
 * acknowledgment false, or the content hash mismatches. Maps to HTTP 422 at the
 * daemon boundary. No bytes are sent.
 */
export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

/**
 * Enforce the informed-consent gate against the exact content being sent. Throws
 * `ConsentError` on any failure. Returns the (validated) content hash on success.
 * No key material is read or referenced here — consent is key-free by design.
 */
export function assertConsent(
  session: SanitizedSession,
  consent: ContributionConsent | undefined,
): string {
  if (!consent) throw new ConsentError('consent is required before submission');
  if (!consent.tosRiskAcknowledged) {
    throw new ConsentError('ToS-risk acknowledgment is required (tosRiskAcknowledged must be true)');
  }
  if (!consent.fullRetentionAcknowledged) {
    throw new ConsentError(
      'full-retention acknowledgment is required (fullRetentionAcknowledged must be true)',
    );
  }
  const contentHash = computeContentHash(session);
  if (consent.contentHash !== contentHash) {
    throw new ConsentError(
      'consent content hash does not match the session being submitted (consent cannot be replayed against changed content)',
    );
  }
  return contentHash;
}
