import { describe, expect, it } from 'vitest';

import * as replayBundle from '../index.js';

describe('@mosga/replay-bundle package surface', () => {
  it('exposes only construction, canonical serialization, seal, and validation entry points', () => {
    expect(Object.keys(replayBundle).sort()).toEqual([
      'canonicalizeReplayJson',
      'createReplayDraft',
      'sealReplayBundle',
      'serializeInstructionFile',
      'serializeNativeJsonl',
      'validateReplayBundle',
    ]);
    for (const entry of Object.values(replayBundle)) {
      expect(entry).toBeTypeOf('function');
    }
  });
});
