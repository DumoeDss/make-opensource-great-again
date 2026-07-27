/**
 * Consent validation tests: every branch of `assertCliResumeConsent`.
 */
import { describe, expect, it } from 'vitest';

import { assertCliResumeConsent } from '../consent.js';
import {
  sealedBundle,
  bundleContentHash,
  validConsent,
} from './fixtures.js';
import { validateReplayBundle } from '@mosga/replay-bundle';

import type { CliResumeConsent } from '@mosga/contracts';

function setup(): { consent: CliResumeConsent; payload: ReturnType<typeof validateReplayBundle>; hash: `sha256:${string}` } {
  const bundle = sealedBundle();
  return {
    consent: validConsent(bundle),
    payload: validateReplayBundle(bundle),
    hash: bundleContentHash(bundle),
  };
}

describe('assertCliResumeConsent', () => {
  it('passes for a valid consent matching the sealed bundle', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(consent, payload, hash);
    expect(result.ok).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it('fails for missing consent', () => {
    const { payload, hash } = setup();
    expect(assertCliResumeConsent(null, payload, hash)).toEqual({
      ok: false,
      violation: 'missing-consent',
    });
  });

  it('fails when tosRiskAcknowledged is false', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      { ...consent, tosRiskAcknowledged: false },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('tos-risk-not-acknowledged');
  });

  it('fails when fullRetentionAcknowledged is false', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      { ...consent, fullRetentionAcknowledged: false },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('full-retention-not-acknowledged');
  });

  it('fails when runtimeContextAcknowledged is false', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      { ...consent, runtimeContextAcknowledged: false },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('runtime-context-not-acknowledged');
  });

  it('fails when bundle hash mismatches', () => {
    const { consent, payload } = setup();
    const result = assertCliResumeConsent(
      consent,
      payload,
      'sha256:' + '0'.repeat(64),
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('bundle-hash-mismatch');
  });

  it('fails when target provider mismatches', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      { ...consent, targetProviderId: 'wrong' },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('target-provider-mismatch');
  });

  it('fails when target model mismatches', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      { ...consent, targetModel: 'wrong' },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('target-model-mismatch');
  });

  it('fails when replay mode mismatches (consent is not cli-resume)', () => {
    const { consent, payload, hash } = setup();
    // The schema enforces literal 'cli-resume', but the consent object is
    // constructed directly in tests. Cast to test the mismatch path.
    const result = assertCliResumeConsent(
      { ...consent, replayMode: 'turn-by-turn' as unknown as 'cli-resume' },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('replay-mode-mismatch');
  });

  it('fails when instruction policy mismatches', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      {
        ...consent,
        instructionPolicy:
          'raw-snapshot' as unknown as 'sanitized-snapshot',
      },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('instruction-policy-mismatch');
  });

  it('fails when skill policy mismatches', () => {
    const { consent, payload, hash } = setup();
    const result = assertCliResumeConsent(
      {
        ...consent,
        skillPolicy:
          'full-discovery' as unknown as 'cli-discovery-read-only',
      },
      payload,
      hash,
    );
    expect(result.ok).toBe(false);
    expect(result.violation).toBe('skill-policy-mismatch');
  });
});
