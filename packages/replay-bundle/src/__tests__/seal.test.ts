import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeReplayJson,
  serializeInstructionFile,
  serializeNativeJsonl,
} from '../canonical.js';
import { sealReplayBundle } from '../integrity.js';
import {
  makeReviewedPayload,
  refreshReviewedDraftHash,
} from './fixtures.js';

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('sealReplayBundle', () => {
  it('derives sorted content entries and a domain-separated root hash', () => {
    const payload = makeReviewedPayload();
    payload.nativeSession.files.push({
      id: 'auxiliary',
      role: 'auxiliary',
      logicalPath: 'native/a-auxiliary.jsonl',
      rows: [{ ordinal: 0, value: { type: 'future', keep: true } }],
    });
    refreshReviewedDraftHash(payload);

    const bundle = sealReplayBundle(payload);

    expect(bundle.integrity).toMatchObject({
      algorithm: 'sha256',
      canonicalization: 'mosga-replay-canonical-json-v1',
    });
    expect(bundle.integrity.entries.map((entry) => entry.path)).toEqual([
      'native/a-auxiliary.jsonl',
      'native/session.jsonl',
      'workspace/CLAUDE.md',
    ]);
    const bytesByPath = new Map([
      [
        'native/a-auxiliary.jsonl',
        serializeNativeJsonl(payload.nativeSession.files[1]!),
      ],
      [
        'native/session.jsonl',
        serializeNativeJsonl(payload.nativeSession.files[0]!),
      ],
      [
        'workspace/CLAUDE.md',
        serializeInstructionFile(payload.instructionSnapshot.files[0]!),
      ],
    ]);
    for (const entry of bundle.integrity.entries) {
      const bytes = bytesByPath.get(entry.path)!;
      expect(entry.byteLength).toBe(bytes.byteLength);
      expect(entry.digest).toBe(sha256(bytes));
    }
    expect(bundle.integrity.contentHash).toBe(
      sha256(
        canonicalizeReplayJson({
          domain: 'mosga-replay-bundle:v1',
          payload,
          entries: bundle.integrity.entries,
        }),
      ),
    );
  });

  it('is pure and deterministic for identical reviewed payloads', () => {
    const payload = makeReviewedPayload();
    const before = structuredClone(payload);

    expect(sealReplayBundle(payload)).toEqual(sealReplayBundle(payload));
    expect(payload).toEqual(before);
  });

  it('refuses pending blocking and opaque review decisions', () => {
    const blocking = makeReviewedPayload();
    blocking.review.findings.push({
      id: 'finding-1',
      layer: 'custom',
      ruleId: 'fake',
      category: null,
      location: {
        kind: 'instruction',
        instructionId: 'instruction-fixture',
        span: { start: 0, end: 1 },
      },
      matchPreview: '[redacted]',
      matchHash: `sha256:${'a'.repeat(64)}`,
      replacementSuggestion: '<SAFE>',
      disposition: 'pending',
      blocking: true,
    });
    expect(() => sealReplayBundle(blocking)).toThrow(/pending blocking/);

    const opaque = makeReviewedPayload();
    opaque.review.opaqueItems.push({
      id: 'opaque-1',
      location: {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 0,
        jsonPointer: '/content/0',
      },
      blockType: 'image',
      matchPreview: '[opaque:image]',
      disposition: 'pending',
      replacement: null,
    });
    expect(() => sealReplayBundle(opaque)).toThrow(/pending blocking/);

    const privacy = makeReviewedPayload();
    privacy.nativeSession.files[0]!.rows[0]!.value = {
      cwd: '/Users/private/repository',
    };
    privacy.review.findings.push({
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
    refreshReviewedDraftHash(privacy);
    expect(() => sealReplayBundle(privacy)).toThrow(
      /privacy normalization/,
    );
  });

  it('refuses duplicate native file, row, and instruction ids', () => {
    const duplicateFileIds = makeReviewedPayload();
    duplicateFileIds.nativeSession.files.push({
      id: 'transcript',
      role: 'auxiliary',
      logicalPath: 'native/second-session.jsonl',
      rows: [{ ordinal: 0, value: { type: 'second' } }],
    });
    expect(() => sealReplayBundle(duplicateFileIds)).toThrow(
      /payload is invalid/,
    );

    const duplicateRowOrdinals = makeReviewedPayload();
    duplicateRowOrdinals.nativeSession.files[0]!.rows.push({
      ordinal: 0,
      value: { type: 'second' },
    });
    expect(() => sealReplayBundle(duplicateRowOrdinals)).toThrow(
      /payload is invalid/,
    );

    const duplicateInstructionIds = makeReviewedPayload();
    duplicateInstructionIds.instructionSnapshot.files.push({
      id: 'instruction-fixture',
      kind: 'claude-md',
      stagePath: 'workspace/nested/CLAUDE.md',
      effectiveOrder: 1,
      content: 'second',
    });
    expect(() => sealReplayBundle(duplicateInstructionIds)).toThrow(
      /payload is invalid/,
    );
  });

  it('refuses payload identity mismatches and unsafe or duplicate entry paths', () => {
    const identity = makeReviewedPayload();
    identity.review.rulesetVersion = 'different-rules';
    expect(() => sealReplayBundle(identity)).toThrow(
      /identities do not match/,
    );

    const unsafe = makeReviewedPayload();
    unsafe.nativeSession.files[0]!.logicalPath = '../session.jsonl';
    refreshReviewedDraftHash(unsafe);
    expect(() => sealReplayBundle(unsafe)).toThrow(/path is unsafe/);

    const duplicate = makeReviewedPayload();
    duplicate.nativeSession.files[0]!.logicalPath =
      duplicate.instructionSnapshot.files[0]!.stagePath;
    refreshReviewedDraftHash(duplicate);
    expect(() => sealReplayBundle(duplicate)).toThrow(/must be unique/);
  });
});
