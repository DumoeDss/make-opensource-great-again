/**
 * Validated-bundle extraction.
 *
 * Calls `validateReplayBundle` to obtain the `ReplayBundlePayload` (seed,
 * omissions, review evidence, delivery target). Reads the integrity
 * `contentHash` from the validated input. This is a cheap, self-contained
 * operation with no side effects.
 *
 * The runtime re-validates the bundle internally for its own materialization;
 * both validations derive the same domain-separated root hash. The consent is
 * validated against the extracted payload before the expensive `prepare` call.
 */
import type {
  CliResumeConsent,
  ReplayBundlePayload,
  ReplayBundle,
} from '@mosga/contracts';
import { validateReplayBundle } from '@mosga/replay-bundle';

import type { ConsentValidationResult } from './consent.js';
import { assertCliResumeConsent } from './consent.js';

export interface ExtractedBundle {
  readonly payload: ReplayBundlePayload;
  readonly bundleContentHash: `sha256:${string}`;
}

export type ExtractAndValidateResult =
  | { readonly ok: true; readonly extracted: ExtractedBundle }
  | {
      readonly ok: false;
      readonly bundleErrorCode?: string;
      readonly consentValidation?: ConsentValidationResult;
    };

/**
 * Extract + validate the bundle, then validate consent against the extracted
 * payload. Both steps happen BEFORE any side effect (CLI probe, workspace).
 *
 * On bundle validation failure, returns `ok: false` with the integrity error
 * code. On consent validation failure, returns `ok: false` with the violation.
 */
export function extractValidatedBundle(
  bundle: unknown,
  consent: CliResumeConsent,
): ExtractAndValidateResult {
  let payload: ReplayBundlePayload;
  let bundleContentHash: `sha256:${string}`;

  try {
    payload = validateReplayBundle(bundle);
  } catch (error) {
    const code = extractIntegrityErrorCode(error);
    return { ok: false, bundleErrorCode: code };
  }

  // Read the validated content hash from the sealed bundle's integrity section.
  const typedBundle = bundle as ReplayBundle;
  bundleContentHash = typedBundle.integrity.contentHash as `sha256:${string}`;

  const consentValidation = assertCliResumeConsent(
    consent,
    payload,
    bundleContentHash,
  );
  if (!consentValidation.ok) {
    return { ok: false, consentValidation };
  }

  return {
    ok: true,
    extracted: { payload, bundleContentHash },
  };
}

/**
 * Extract the stable integrity error code from a thrown validation error.
 * The bundle foundation throws errors with a `code` property.
 */
function extractIntegrityErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'invalid-bundle';
}
