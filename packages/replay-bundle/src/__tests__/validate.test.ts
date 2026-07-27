import { describe, expect, it } from 'vitest';

import {
  sealReplayBundle,
  validateReplayBundle,
  type ReplayBundleIntegrityErrorCode,
} from '../integrity.js';
import {
  makeReviewedPayload,
  refreshReviewedDraftHash,
} from './fixtures.js';

function expectCode(
  action: () => unknown,
  code: ReplayBundleIntegrityErrorCode,
): void {
  try {
    action();
    throw new Error('Expected replay validation to fail.');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('validateReplayBundle', () => {
  it('validates and clones an intact bundle using only supplied content', () => {
    const bundle = sealReplayBundle(makeReviewedPayload());
    const before = structuredClone(bundle);

    const validated = validateReplayBundle(bundle);

    expect(validated).toEqual(bundle.payload);
    expect(validated).not.toBe(bundle.payload);
    expect(bundle).toEqual(before);
  });

  it('detects native and instruction mutations through the rederived manifest', () => {
    const native = sealReplayBundle(makeReviewedPayload());
    (
      native.payload.nativeSession.files[0]!.rows[0]!.value as {
        message: { content: string };
      }
    ).message.content = 'mutated';
    expectCode(
      () => validateReplayBundle(native),
      'review-content-mismatch',
    );

    const instruction = sealReplayBundle(makeReviewedPayload());
    instruction.payload.instructionSnapshot.files[0]!.content =
      'mutated instructions';
    expectCode(
      () => validateReplayBundle(instruction),
      'review-content-mismatch',
    );
  });

  it('rejects a stored payload with unresolved privacy normalization review', () => {
    const bundle = sealReplayBundle(makeReviewedPayload());
    bundle.payload.nativeSession.files[0]!.rows[0]!.value = {
      cwd: '/Users/private/repository',
    };
    bundle.payload.review.findings.push({
      id: 'path-finding',
      layer: 'normalization',
      ruleId: 'path',
      category: 'path',
      location: {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 0,
        jsonPointer: '/cwd',
        span: { start: 0, end: 25 },
      },
      matchPreview: '[redacted:normalization:path]',
      matchHash: `sha256:${'b'.repeat(64)}`,
      replacementSuggestion: '<PATH_1>',
      disposition: 'pending',
      blocking: false,
    });
    refreshReviewedDraftHash(bundle.payload);

    expectCode(
      () => validateReplayBundle(bundle),
      'review-gate-locked',
    );
  });

  it('detects missing, extra, or reordered manifest entries', () => {
    const missing = sealReplayBundle(makeReviewedPayload());
    missing.integrity.entries.pop();
    expectCode(() => validateReplayBundle(missing), 'manifest-mismatch');

    const extra = sealReplayBundle(makeReviewedPayload());
    extra.integrity.entries.push({
      path: 'native/extra.jsonl',
      mediaType: 'application/jsonl',
      byteLength: 0,
      digest: `sha256:${'a'.repeat(64)}`,
    });
    expectCode(() => validateReplayBundle(extra), 'manifest-mismatch');

    const reordered = sealReplayBundle(makeReviewedPayload());
    reordered.integrity.entries.reverse();
    expectCode(
      () => validateReplayBundle(reordered),
      'manifest-mismatch',
    );
  });

  it('reports stable unsafe-path and malformed-digest failures', () => {
    const unsafe = sealReplayBundle(makeReviewedPayload());
    unsafe.integrity.entries[0]!.path = '../escape.jsonl';
    expectCode(() => validateReplayBundle(unsafe), 'unsafe-entry-path');

    const legacyDigest = sealReplayBundle(makeReviewedPayload());
    (
      legacyDigest.integrity as { contentHash: string }
    ).contentHash = 'a'.repeat(64);
    expectCode(
      () => validateReplayBundle(legacyDigest),
      'malformed-digest',
    );
  });

  it('reports unsupported versions and a validly-shaped wrong root', () => {
    const unsupported = sealReplayBundle(makeReviewedPayload()) as unknown as {
      payload: { schemaVersion: string };
    };
    unsupported.payload.schemaVersion = '2.0.0';
    expectCode(
      () => validateReplayBundle(unsupported),
      'unsupported-version',
    );

    const wrongRoot = sealReplayBundle(makeReviewedPayload());
    wrongRoot.integrity.contentHash = `sha256:${'f'.repeat(64)}`;
    expectCode(
      () => validateReplayBundle(wrongRoot),
      'content-hash-mismatch',
    );
  });

  it('detects sealed policy mutation even when content entries are unchanged', () => {
    const bundle = sealReplayBundle(makeReviewedPayload());
    bundle.payload.delivery.targetModel = 'mutated-target';
    bundle.payload.terminalManifestSeed.delivery.targetModel =
      'mutated-target';

    expectCode(
      () => validateReplayBundle(bundle),
      'review-content-mismatch',
    );
  });
});
