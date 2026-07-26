import { describe, expect, it } from 'vitest';

import { createReplayDraft } from '../draft.js';
import { makeCreateDraftInput } from './fixtures.js';

describe('createReplayDraft', () => {
  it('purely constructs a strict draft from capture and explicit candidates', () => {
    const input = makeCreateDraftInput();
    const before = structuredClone(input);

    const draft = createReplayDraft(input);

    expect(draft).toMatchObject({
      schemaVersion: '1.0.0',
      draftId: 'draft-1',
      source: input.nativeCapture.source,
      nativeSession: input.nativeCapture.artifact,
      terminalManifestSeed: input.terminalManifestSeed,
      runtimePolicy: input.runtimePolicy,
      delivery: input.delivery,
      omissions: input.omissions,
    });
    expect(draft.instructionSnapshot.files).toEqual([
      expect.objectContaining({
        kind: 'claude-md',
        stagePath: 'workspace/CLAUDE.md',
        effectiveOrder: 0,
        content: 'reviewed\ninstructions',
      }),
    ]);
    expect(JSON.stringify(draft)).not.toContain('C:\\\\private');
    expect(JSON.stringify(draft)).not.toContain('sourcePath');
    expect(input).toEqual(before);
  });

  it('supports an explicitly empty instruction snapshot without discovery', () => {
    const input = makeCreateDraftInput();
    input.instructionCandidates = [];

    expect(createReplayDraft(input).instructionSnapshot.files).toEqual([]);
  });

  it('rejects mismatched captured source identity', () => {
    const input = makeCreateDraftInput();
    input.nativeCapture.artifact.sessionIdAlias = 'different-session';

    expect(() => createReplayDraft(input)).toThrow(/identities must match/);
  });

  it('rejects a terminal seed that differs from capture, policy, or delivery', () => {
    const sourceMismatch = makeCreateDraftInput();
    sourceMismatch.terminalManifestSeed.source.recordedCliVersion = '9.9.9';
    expect(() => createReplayDraft(sourceMismatch)).toThrow(
      /identities must match/,
    );

    const trajectoryMismatch = makeCreateDraftInput();
    trajectoryMismatch.terminalManifestSeed.trajectory.totalRows += 1;
    expect(() => createReplayDraft(trajectoryMismatch)).toThrow(
      /identities must match/,
    );

    const deliveryMismatch = makeCreateDraftInput();
    deliveryMismatch.terminalManifestSeed.delivery.targetModel =
      'different-model';
    expect(() => createReplayDraft(deliveryMismatch)).toThrow(
      /identities must match/,
    );
  });
});
