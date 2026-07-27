import type { ReplayBundle } from '@mosga/contracts';
import { sealReplayBundle } from '@mosga/replay-bundle';

import {
  makeReviewedPayload,
  refreshReviewedDraftHash,
} from '../../../replay-bundle/src/__tests__/fixtures.js';

export function sealedBundle(
  sourceCli: 'claude-code' | 'codex' = 'claude-code',
): ReplayBundle {
  const payload = makeReviewedPayload();
  if (sourceCli === 'codex') {
    payload.source.sourceCli = 'codex';
    payload.source.sourceFormat = 'codex-jsonl';
    payload.source.recordedCliVersion = '0.100.0';
    payload.nativeSession.sourceCli = 'codex';
    payload.nativeSession.sourceFormat = 'codex-jsonl';
    payload.terminalManifestSeed.source.sourceCli = 'codex';
    payload.terminalManifestSeed.source.sourceFormat = 'codex-jsonl';
    payload.terminalManifestSeed.source.recordedCliVersion = '0.100.0';
  }
  refreshReviewedDraftHash(payload);
  return sealReplayBundle(payload);
}
