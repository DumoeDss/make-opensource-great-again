import type {
  NativeCaptureSuccess,
  ReplayBundlePayload,
} from '@mosga/contracts';

import type { CreateReplayDraftInput } from '../draft.js';
import { computeReplayReviewedDraftHash } from '../integrity.js';

export const AT = '2026-07-27T00:00:00.000Z';

export function makeNativeCapture(): NativeCaptureSuccess {
  const source = {
    schemaVersion: '1.0.0' as const,
    sourceCli: 'claude-code' as const,
    sourceFormat: 'claude-code-jsonl' as const,
    sessionIdAlias: 'session-1',
    recordedCliVersion: '1.2.3',
    modelProvider: 'anthropic',
    sourceModels: ['claude-fake'],
    modelTimeline: [
      {
        assistantTurnIndex: 0,
        model: 'claude-fake',
        effort: 'high',
      },
    ],
    contextWindow: 200_000,
    sessionMode: 'interactive' as const,
    entrypoint: 'terminal' as const,
  };
  const trajectory = {
    schemaVersion: '1.0.0' as const,
    totalRows: 2,
    userTurns: 1,
    assistantTurns: 1,
    toolCalls: 0,
    toolResults: 0,
    compactedEvents: 0,
  };
  return {
    ok: true,
    artifact: {
      schemaVersion: '1.0.0',
      sourceCli: 'claude-code',
      sourceFormat: 'claude-code-jsonl',
      sessionIdAlias: 'session-1',
      files: [
        {
          id: 'transcript',
          role: 'primary',
          logicalPath: 'native/session.jsonl',
          rows: [
            {
              ordinal: 0,
              value: {
                type: 'user',
                message: { content: 'hello' },
              },
            },
            {
              ordinal: 1,
              value: {
                type: 'assistant',
                message: { content: 'world' },
              },
            },
          ],
        },
      ],
    },
    source,
    trajectory,
  };
}

export function makeCreateDraftInput(): CreateReplayDraftInput {
  const nativeCapture = makeNativeCapture();
  const delivery = {
    schemaVersion: '1.0.0' as const,
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
  };
  return {
    draftId: 'draft-1',
    nativeCapture,
    instructionCandidates: [
      {
        sourcePath: 'C:\\private\\CLAUDE.md',
        kind: 'claude-md',
        stagePath: 'workspace/CLAUDE.md',
        effectiveOrder: 0,
        content: 'reviewed\r\ninstructions',
      },
    ],
    terminalManifestSeed: {
      schemaVersion: '1.0.0',
      kind: 'mosga-replay-terminal-manifest-seed',
      purpose: 'open-source-contribution',
      source: structuredClone(nativeCapture.source),
      trajectory: structuredClone(nativeCapture.trajectory),
      sanitization: {
        rulesetVersion: 'rules-1',
        reportVersion: '1.0.0',
        sanitizerPackageVersion: '0.1.0',
      },
      omissionPolicy: 'explicit-known-omissions',
      replayMode: 'cli-resume',
      instructionPolicy: 'sanitized-snapshot',
      skillPolicy: 'cli-discovery-read-only',
      proxyRescan: false,
      maxInferenceRequests: 1,
      delivery: structuredClone(delivery),
    },
    runtimePolicy: {
      schemaVersion: '1.0.0',
      replayMode: 'cli-resume',
      instructionPolicy: 'sanitized-snapshot',
      skillPolicy: 'cli-discovery-read-only',
      proxyRescan: false,
      maxInferenceRequests: 1,
      projectAlias: 'project-1',
      workingDirectoryAlias: 'workspace/project-1',
    },
    delivery,
    omissions: [
      {
        id: 'omission-1',
        category: 'source-context',
        reason: 'not-recorded',
        disclosure: 'Repository identity was not retained.',
        relatedId: 'repository',
      },
    ],
  };
}

export function refreshReviewedDraftHash(
  payload: ReplayBundlePayload,
): ReplayBundlePayload {
  payload.review.reviewedDraftHash =
    computeReplayReviewedDraftHash(payload);
  return payload;
}

export function makeReviewedPayload(): ReplayBundlePayload {
  const input = makeCreateDraftInput();
  return refreshReviewedDraftHash({
    schemaVersion: '1.0.0',
    draftId: input.draftId,
    source: structuredClone(input.nativeCapture.source),
    nativeSession: structuredClone(input.nativeCapture.artifact),
    instructionSnapshot: {
      schemaVersion: '1.0.0',
      files: [
        {
          id: 'instruction-fixture',
          kind: 'claude-md',
          stagePath: 'workspace/CLAUDE.md',
          effectiveOrder: 0,
          content: 'reviewed\ninstructions',
        },
      ],
    },
    terminalManifestSeed: structuredClone(input.terminalManifestSeed),
    runtimePolicy: structuredClone(input.runtimePolicy),
    delivery: structuredClone(input.delivery),
    omissions: structuredClone(input.omissions),
    review: {
      schemaVersion: '1.0.0',
      draftId: input.draftId,
      rulesetVersion: 'rules-1',
      reportVersion: '1.0.0',
      decisionVersion: 'decisions-1',
      reviewedDraftHash: `sha256:${'0'.repeat(64)}`,
      findings: [],
      opaqueItems: [],
      approvedAt: AT,
      humanReviewPassed: true,
    },
  });
}
