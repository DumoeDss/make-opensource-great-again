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
    throw new Error('Expected replay integrity operation to fail.');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('ReplayBundle integrity behavior matrix', () => {
  it('seals identical payloads byte-for-byte deterministically', () => {
    const payload = makeReviewedPayload();

    const first = sealReplayBundle(structuredClone(payload));
    const second = sealReplayBundle(structuredClone(payload));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.integrity.entries).toEqual(second.integrity.entries);
    expect(first.integrity.contentHash).toBe(
      second.integrity.contentHash,
    );
  });

  it('changes the native entry digest and root when row order changes', () => {
    const original = makeReviewedPayload();
    const reordered = structuredClone(original);
    reordered.nativeSession.files[0]!.rows.reverse();
    refreshReviewedDraftHash(reordered);

    const originalBundle = sealReplayBundle(original);
    const reorderedBundle = sealReplayBundle(reordered);
    const originalNative = originalBundle.integrity.entries.find(
      (entry) => entry.mediaType === 'application/jsonl',
    )!;
    const reorderedNative = reorderedBundle.integrity.entries.find(
      (entry) => entry.mediaType === 'application/jsonl',
    )!;

    expect(reorderedNative.digest).not.toBe(originalNative.digest);
    expect(reorderedBundle.integrity.contentHash).not.toBe(
      originalBundle.integrity.contentHash,
    );
  });

  it('changes the root when fixed delivery policy changes', () => {
    const original = makeReviewedPayload();
    const changed = structuredClone(original);
    changed.delivery.targetModel = 'different-target-model';
    changed.terminalManifestSeed.delivery.targetModel =
      'different-target-model';
    refreshReviewedDraftHash(changed);

    const originalBundle = sealReplayBundle(original);
    const changedBundle = sealReplayBundle(changed);

    expect(changedBundle.integrity.entries).toEqual(
      originalBundle.integrity.entries,
    );
    expect(changedBundle.integrity.contentHash).not.toBe(
      originalBundle.integrity.contentHash,
    );
  });

  it('validates without source files and rejects later native/instruction mutations', () => {
    const bundle = sealReplayBundle(makeReviewedPayload());
    expect(validateReplayBundle(structuredClone(bundle))).toEqual(
      bundle.payload,
    );

    const native = structuredClone(bundle);
    (
      native.payload.nativeSession.files[0]!.rows[0]!.value as {
        message: { content: string };
      }
    ).message.content = 'changed after sealing';
    expectCode(
      () => validateReplayBundle(native),
      'review-content-mismatch',
    );

    const instruction = structuredClone(bundle);
    instruction.payload.instructionSnapshot.files[0]!.content =
      'changed after sealing';
    expectCode(
      () => validateReplayBundle(instruction),
      'review-content-mismatch',
    );
  });

  it('explicitly rejects legacy unprefixed root and entry hashes', () => {
    const root = sealReplayBundle(makeReviewedPayload());
    (root.integrity as { contentHash: string }).contentHash =
      'a'.repeat(64);
    expectCode(() => validateReplayBundle(root), 'malformed-digest');

    const entry = sealReplayBundle(makeReviewedPayload());
    (entry.integrity.entries[0] as { digest: string }).digest =
      'b'.repeat(64);
    expectCode(() => validateReplayBundle(entry), 'malformed-digest');
  });

  it('rejects instruction entry basenames not recognized by the declared kind', () => {
    const payload = makeReviewedPayload();
    payload.instructionSnapshot.files[0]!.stagePath =
      'workspace/README.md';
    refreshReviewedDraftHash(payload);

    expectCode(() => sealReplayBundle(payload), 'unsafe-entry-path');
  });
});
