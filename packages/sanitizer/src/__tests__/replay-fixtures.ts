import type { ReplayBundleDraft } from '@mosga/contracts';

export function makeReplayDraft(): ReplayBundleDraft {
  const source = {
    schemaVersion: '1.0.0' as const,
    sourceCli: 'claude-code' as const,
    sourceFormat: 'claude-code-jsonl' as const,
    sessionIdAlias: 'session-1',
    recordedCliVersion: '1.2.3',
    modelProvider: 'anthropic',
    sourceModels: ['claude-fake'],
    modelTimeline: [
      { assistantTurnIndex: 0, model: 'claude-fake', effort: 'high' },
    ],
    contextWindow: 200_000,
    sessionMode: 'interactive' as const,
    entrypoint: 'terminal' as const,
  };
  const trajectory = {
    schemaVersion: '1.0.0' as const,
    totalRows: 1,
    userTurns: 1,
    assistantTurns: 0,
    toolCalls: 0,
    toolResults: 0,
    compactedEvents: 0,
  };
  const delivery = {
    schemaVersion: '1.0.0' as const,
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
  };

  return {
    schemaVersion: '1.0.0',
    draftId: 'draft-1',
    source,
    nativeSession: {
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
              ordinal: 7,
              value: {
                type: 'future',
                'a/b~c': {
                  content: [
                    { text: 'first leaf' },
                    { encoded: '{"secret":"JSON_ENCODED_CANARY"}' },
                  ],
                },
                count: 3,
                enabled: true,
                nothing: null,
              },
            },
          ],
        },
      ],
    },
    instructionSnapshot: {
      schemaVersion: '1.0.0',
      files: [
        {
          id: 'instruction-1',
          kind: 'claude-md',
          stagePath: 'workspace/CLAUDE.md',
          effectiveOrder: 0,
          content: 'Instruction canary',
        },
      ],
    },
    terminalManifestSeed: {
      schemaVersion: '1.0.0',
      kind: 'mosga-replay-terminal-manifest-seed',
      purpose: 'open-source-contribution',
      source,
      trajectory,
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
      delivery,
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
