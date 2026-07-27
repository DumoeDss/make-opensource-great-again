/**
 * Cli-resume consent validation.
 *
 * Validates the `CliResumeConsent` record against the extracted bundle payload
 * BEFORE any expensive side effect (CLI probe, workspace creation). Consent is
 * the fast-fail gate: if the hash, target, mode, or any policy field does not
 * match the sealed values, the orchestration returns `consent-invalid` without
 * calling `runtime.prepare`.
 */
import type {
  CliResumeConsent,
  ReplayBundlePayload,
} from '@mosga/contracts';

export type ConsentViolation =
  | 'missing-consent'
  | 'tos-risk-not-acknowledged'
  | 'full-retention-not-acknowledged'
  | 'runtime-context-not-acknowledged'
  | 'bundle-hash-mismatch'
  | 'target-provider-mismatch'
  | 'target-model-mismatch'
  | 'replay-mode-mismatch'
  | 'instruction-policy-mismatch'
  | 'skill-policy-mismatch';

export interface ConsentValidationResult {
  readonly ok: boolean;
  readonly violation?: ConsentViolation;
}

/**
 * Validate cli-resume consent against the extracted bundle payload.
 *
 * Checks (in order):
 * 1. Consent is present.
 * 2. All three acknowledgments are true.
 * 3. `consent.bundleContentHash` equals the validated hash.
 * 4. Target provider matches the sealed delivery target.
 * 5. Target model matches the sealed delivery target.
 * 6. Replay mode is `cli-resume` (enforced by schema, but checked for defense).
 * 7. Instruction policy matches the sealed runtime policy.
 * 8. Skill policy matches the sealed runtime policy.
 */
export function assertCliResumeConsent(
  consent: CliResumeConsent | null | undefined,
  payload: ReplayBundlePayload,
  bundleContentHash: `sha256:${string}`,
): ConsentValidationResult {
  if (!consent) {
    return { ok: false, violation: 'missing-consent' };
  }

  if (!consent.tosRiskAcknowledged) {
    return { ok: false, violation: 'tos-risk-not-acknowledged' };
  }
  if (!consent.fullRetentionAcknowledged) {
    return { ok: false, violation: 'full-retention-not-acknowledged' };
  }
  if (!consent.runtimeContextAcknowledged) {
    return { ok: false, violation: 'runtime-context-not-acknowledged' };
  }

  if (consent.bundleContentHash !== bundleContentHash) {
    return { ok: false, violation: 'bundle-hash-mismatch' };
  }

  if (consent.targetProviderId !== payload.delivery.targetProviderId) {
    return { ok: false, violation: 'target-provider-mismatch' };
  }
  if (consent.targetModel !== payload.delivery.targetModel) {
    return { ok: false, violation: 'target-model-mismatch' };
  }

  if (consent.replayMode !== payload.runtimePolicy.replayMode) {
    return { ok: false, violation: 'replay-mode-mismatch' };
  }
  if (consent.instructionPolicy !== payload.runtimePolicy.instructionPolicy) {
    return { ok: false, violation: 'instruction-policy-mismatch' };
  }
  if (consent.skillPolicy !== payload.runtimePolicy.skillPolicy) {
    return { ok: false, violation: 'skill-policy-mismatch' };
  }

  return { ok: true };
}
