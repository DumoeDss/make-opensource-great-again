import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  JsonValueSchema,
  InstructionCandidateSchema,
  InstructionSnapshotSchema,
  NativeCaptureResultSchema,
  NativeSessionArtifactSchema,
  ReplayBundleSchema,
  ReplayBundleDraftSchema,
  ReplayBundleIntegritySchema,
  ReplayBundlePayloadSchema,
  ReplayFindingLocationSchema,
  ReplayFindingSchema,
  ReplayOpaqueItemSchema,
  ReplayReviewEvidenceSchema,
  canonicalizeReplayReviewedDraft,
  ReplayDeliveryTargetSchema,
  ReplayOmissionSchema,
  ReplayRuntimePolicySchema,
  ReplayTrajectorySchema,
  SafeSourceSummarySchema,
  TerminalManifestSeedSchema,
} from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeSource() {
  return {
    schemaVersion: '1.0.0' as const,
    sourceCli: 'claude-code' as const,
    sourceFormat: 'claude-code-jsonl' as const,
    sessionIdAlias: 'session-1',
    recordedCliVersion: '1.2.3',
    modelProvider: 'anthropic',
    sourceModels: ['source-model-a'],
    modelTimeline: [
      {
        assistantTurnIndex: 0,
        model: 'source-model-a',
        effort: null,
      },
    ],
    contextWindow: 200_000,
    sessionMode: 'interactive' as const,
    entrypoint: 'terminal' as const,
  };
}

function fakeArtifact() {
  return {
    schemaVersion: '1.0.0' as const,
    sourceCli: 'claude-code' as const,
    sourceFormat: 'claude-code-jsonl' as const,
    sessionIdAlias: 'session-1',
    files: [
      {
        id: 'transcript',
        role: 'primary' as const,
        logicalPath: 'native/session.jsonl',
        rows: [
          {
            ordinal: 0,
            value: {
              type: 'future-row',
              nested: {
                array: [null, true, 4.5, 'text', { reference: 'tool-1' }],
              },
            },
          },
        ],
      },
    ],
  };
}

function fakeReviewedPayload() {
  const source = fakeSource();
  const delivery = {
    schemaVersion: '1.0.0' as const,
    targetProviderId: 'target-provider',
    targetModel: 'different-target-model',
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
  const runtimePolicy = {
    schemaVersion: '1.0.0' as const,
    replayMode: 'cli-resume' as const,
    instructionPolicy: 'sanitized-snapshot' as const,
    skillPolicy: 'cli-discovery-read-only' as const,
    proxyRescan: false as const,
    maxInferenceRequests: 1 as const,
    projectAlias: 'project-1',
    workingDirectoryAlias: 'workspace/project-1',
  };
  return {
    schemaVersion: '1.0.0' as const,
    draftId: 'draft-id',
    source,
    nativeSession: fakeArtifact(),
    instructionSnapshot: {
      schemaVersion: '1.0.0' as const,
      files: [
        {
          id: 'instruction-1',
          kind: 'claude-md' as const,
          stagePath: 'workspace/CLAUDE.md',
          effectiveOrder: 0,
          content: 'Use only fake fixture data.\n',
        },
      ],
    },
    terminalManifestSeed: {
      schemaVersion: '1.0.0' as const,
      kind: 'mosga-replay-terminal-manifest-seed' as const,
      purpose: 'open-source-contribution' as const,
      source,
      trajectory,
      sanitization: {
        rulesetVersion: 'rules-v1',
        reportVersion: 'report-v1',
        sanitizerPackageVersion: '0.1.0',
      },
      omissionPolicy: 'explicit-known-omissions' as const,
      replayMode: 'cli-resume' as const,
      instructionPolicy: 'sanitized-snapshot' as const,
      skillPolicy: 'cli-discovery-read-only' as const,
      proxyRescan: false as const,
      maxInferenceRequests: 1 as const,
      delivery,
    },
    runtimePolicy,
    delivery,
    omissions: [
      {
        id: 'omission-1',
        category: 'source-context' as const,
        reason: 'not-recorded' as const,
        disclosure: 'No source context-window value was recorded.',
        relatedId: 'contextWindow',
      },
    ],
    review: {
      schemaVersion: '1.0.0' as const,
      draftId: 'draft-id',
      rulesetVersion: 'rules-v1',
      reportVersion: 'report-v1',
      decisionVersion: 'decision-v1',
      reviewedDraftHash: `sha256:${'a'.repeat(64)}`,
      findings: [],
      opaqueItems: [],
      approvedAt: '2026-07-27T00:00:00.000Z',
      humanReviewPassed: true as const,
    },
  };
}

describe('ReplayBundle foundation JSON/native contracts', () => {
  it('accepts complete recursive JSON values and rejects non-JSON values', () => {
    expect(JsonValueSchema.parse(fakeArtifact().files[0]!.rows[0]!.value)).toEqual(
      fakeArtifact().files[0]!.rows[0]!.value,
    );
    expect(JsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(JsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(JsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(JsonValueSchema.safeParse(1n).success).toBe(false);
    expect(JsonValueSchema.safeParse(new Date()).success).toBe(false);
  });

  it('preserves complete native rows and rejects unknown artifact keys', () => {
    expect(NativeSessionArtifactSchema.parse(fakeArtifact())).toEqual(fakeArtifact());
    expect(
      NativeSessionArtifactSchema.safeParse({
        ...fakeArtifact(),
        originalAbsolutePath: 'C:\\Users\\fake\\session.jsonl',
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate native and instruction coordinates', () => {
    const duplicateFileIds = fakeArtifact();
    duplicateFileIds.files.push({
      ...structuredClone(duplicateFileIds.files[0]!),
      logicalPath: 'native/second-session.jsonl',
    });
    expect(NativeSessionArtifactSchema.safeParse(duplicateFileIds).success).toBe(
      false,
    );

    const duplicateRowOrdinals = fakeArtifact();
    duplicateRowOrdinals.files[0]!.rows.push({
      ordinal: duplicateRowOrdinals.files[0]!.rows[0]!.ordinal,
      value: { type: 'second-row' },
    });
    expect(
      NativeSessionArtifactSchema.safeParse(duplicateRowOrdinals).success,
    ).toBe(false);

    const duplicateInstructionIds = fakeReviewedPayload().instructionSnapshot;
    duplicateInstructionIds.files.push({
      ...structuredClone(duplicateInstructionIds.files[0]!),
      stagePath: 'workspace/nested/CLAUDE.md',
    });
    expect(
      InstructionSnapshotSchema.safeParse(duplicateInstructionIds).success,
    ).toBe(false);
  });

  it('strictly validates safe source summaries', () => {
    expect(SafeSourceSummarySchema.parse(fakeSource())).toEqual(fakeSource());
    expect(
      SafeSourceSummarySchema.safeParse({
        ...fakeSource(),
        cwd: 'C:\\Users\\fake\\project',
      }).success,
    ).toBe(false);
  });

  it('uses a no-partial discriminated native capture result', () => {
    expect(
      NativeCaptureResultSchema.parse({
        ok: true,
        artifact: fakeArtifact(),
        source: fakeSource(),
        trajectory: {
          schemaVersion: '1.0.0',
          totalRows: 1,
          userTurns: 0,
          assistantTurns: 0,
          toolCalls: 0,
          toolResults: 0,
          compactedEvents: 0,
        },
      }),
    ).toBeTruthy();

    const failure = {
      ok: false as const,
      error: {
        schemaVersion: '1.0.0' as const,
        sourceCli: 'claude-code' as const,
        code: 'malformed-jsonl' as const,
        message: 'The transcript is not valid JSONL.',
      },
    };
    expect(NativeCaptureResultSchema.parse(failure)).toEqual(failure);
    expect(
      NativeCaptureResultSchema.safeParse({
        ...failure,
        artifact: fakeArtifact(),
      }).success,
    ).toBe(false);
  });
});

describe('ReplayBundle v1 fixed-input contracts', () => {
  const trajectory = {
    schemaVersion: '1.0.0' as const,
    totalRows: 8,
    userTurns: 2,
    assistantTurns: 2,
    toolCalls: 1,
    toolResults: 1,
    compactedEvents: 0,
  };
  const delivery = {
    schemaVersion: '1.0.0' as const,
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
  };

  it('strictly validates candidates, snapshots, omissions, and trajectories', () => {
    const candidate = {
      sourcePath: 'C:\\fake-private\\CLAUDE.md',
      kind: 'claude-md' as const,
      stagePath: 'workspace/CLAUDE.md',
      effectiveOrder: 0,
      content: new TextEncoder().encode('fake instructions'),
    };
    expect(InstructionCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(
      InstructionSnapshotSchema.parse({
        schemaVersion: '1.0.0',
        files: [
          {
            id: 'instruction-1',
            kind: 'claude-md',
            stagePath: 'workspace/CLAUDE.md',
            effectiveOrder: 0,
            content: 'fake instructions\n',
          },
        ],
      }).files,
    ).toHaveLength(1);
    expect(
      ReplayOmissionSchema.parse({
        id: 'omission-1',
        category: 'instruction',
        reason: 'not-approved',
        disclosure: 'An effective instruction was not approved.',
        relatedId: 'instruction-2',
      }).reason,
    ).toBe('not-approved');
    expect(ReplayTrajectorySchema.parse(trajectory)).toEqual(trajectory);
  });

  it('enforces v1 runtime and delivery policies', () => {
    const runtime = {
      schemaVersion: '1.0.0' as const,
      replayMode: 'cli-resume' as const,
      instructionPolicy: 'sanitized-snapshot' as const,
      skillPolicy: 'cli-discovery-read-only' as const,
      proxyRescan: false as const,
      maxInferenceRequests: 1 as const,
      projectAlias: 'project-1',
      workingDirectoryAlias: 'workspace/project-1',
    };
    expect(ReplayRuntimePolicySchema.parse(runtime)).toEqual(runtime);
    expect(ReplayDeliveryTargetSchema.parse(delivery)).toEqual(delivery);
    expect(
      ReplayRuntimePolicySchema.safeParse({
        ...runtime,
        maxInferenceRequests: 2,
      }).success,
    ).toBe(false);
    expect(
      ReplayRuntimePolicySchema.safeParse({
        ...runtime,
        skillPolicy: 'copy-all-skill-bodies',
      }).success,
    ).toBe(false);
  });

  it('validates a deterministic terminal seed and rejects dynamic fields', () => {
    const seed = {
      schemaVersion: '1.0.0' as const,
      kind: 'mosga-replay-terminal-manifest-seed' as const,
      purpose: 'open-source-contribution' as const,
      source: fakeSource(),
      trajectory,
      sanitization: {
        rulesetVersion: 'rules-v1',
        reportVersion: 'report-v1',
        sanitizerPackageVersion: '0.1.0',
      },
      omissionPolicy: 'explicit-known-omissions' as const,
      replayMode: 'cli-resume' as const,
      instructionPolicy: 'sanitized-snapshot' as const,
      skillPolicy: 'cli-discovery-read-only' as const,
      proxyRescan: false as const,
      maxInferenceRequests: 1 as const,
      delivery,
    };
    expect(TerminalManifestSeedSchema.parse(seed)).toEqual(seed);
    expect(
      TerminalManifestSeedSchema.safeParse({
        ...seed,
        replayCliVersion: 'dynamic-version',
      }).success,
    ).toBe(false);
    expect(
      TerminalManifestSeedSchema.safeParse({
        ...seed,
        routeToken: 'forbidden-token',
      }).success,
    ).toBe(false);
  });
});

describe('Replay review and integrity contracts', () => {
  it('strictly validates artifact-aware findings and opaque decisions', () => {
    const location = {
      kind: 'native' as const,
      fileId: 'transcript',
      rowOrdinal: 7,
      jsonPointer: '/payload/content/1/text',
      span: { start: 4, end: 10 },
    };
    expect(ReplayFindingLocationSchema.parse(location)).toEqual(location);
    expect(
      ReplayFindingSchema.parse({
        id: 'finding-1',
        layer: 'secrets',
        ruleId: 'fake-secret-rule',
        category: null,
        location,
        matchPreview: 'fa…et',
        matchHash: `sha256:${'b'.repeat(64)}`,
        replacementSuggestion: '<REDACTED>',
        disposition: 'replace',
        blocking: true,
      }).location,
    ).toEqual(location);
    expect(
      ReplayOpaqueItemSchema.parse({
        id: 'opaque-1',
        location: {
          kind: 'native',
          fileId: 'transcript',
          rowOrdinal: 3,
          jsonPointer: '/message/content/0',
        },
        blockType: 'image',
        matchPreview: '[opaque:image]',
        disposition: 'remove',
        replacement: null,
      }).disposition,
    ).toBe('remove');
  });

  it('separates unreviewed drafts from approved payloads', () => {
    const runtimePolicy = {
      schemaVersion: '1.0.0' as const,
      replayMode: 'cli-resume' as const,
      instructionPolicy: 'sanitized-snapshot' as const,
      skillPolicy: 'cli-discovery-read-only' as const,
      proxyRescan: false as const,
      maxInferenceRequests: 1 as const,
      projectAlias: 'project-1',
      workingDirectoryAlias: 'workspace/project-1',
    };
    const delivery = {
      schemaVersion: '1.0.0' as const,
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
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
    const draft = {
      schemaVersion: '1.0.0' as const,
      draftId: 'draft-id',
      source: fakeSource(),
      nativeSession: fakeArtifact(),
      instructionSnapshot: { schemaVersion: '1.0.0' as const, files: [] },
      terminalManifestSeed: {
        schemaVersion: '1.0.0' as const,
        kind: 'mosga-replay-terminal-manifest-seed' as const,
        purpose: 'open-source-contribution' as const,
        source: fakeSource(),
        trajectory,
        sanitization: {
          rulesetVersion: 'rules-v1',
          reportVersion: 'report-v1',
          sanitizerPackageVersion: '0.1.0',
        },
        omissionPolicy: 'explicit-known-omissions' as const,
        replayMode: 'cli-resume' as const,
        instructionPolicy: 'sanitized-snapshot' as const,
        skillPolicy: 'cli-discovery-read-only' as const,
        proxyRescan: false as const,
        maxInferenceRequests: 1 as const,
        delivery,
      },
      runtimePolicy,
      delivery,
      omissions: [],
    };
    expect(ReplayBundleDraftSchema.parse(draft)).toEqual(draft);
    expect(ReplayBundlePayloadSchema.safeParse(draft).success).toBe(false);

    const review = {
      schemaVersion: '1.0.0' as const,
      draftId: 'draft-id',
      rulesetVersion: 'rules-v1',
      reportVersion: 'report-v1',
      decisionVersion: 'decision-v1',
      reviewedDraftHash: `sha256:${'a'.repeat(64)}`,
      findings: [],
      opaqueItems: [],
      approvedAt: '2026-07-27T00:00:00.000Z',
      humanReviewPassed: true as const,
    };
    expect(ReplayReviewEvidenceSchema.parse(review)).toEqual(review);
    expect(ReplayBundlePayloadSchema.parse({ ...draft, review }).review).toEqual(
      review,
    );
    expect(
      new TextDecoder().decode(
        canonicalizeReplayReviewedDraft({ ...draft, review }),
      ),
    ).toContain('"domain":"mosga-replay-reviewed-draft:v1"');
  });

  it('requires prefixed lowercase sha256 integrity values', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(
      ReplayBundleIntegritySchema.parse({
        algorithm: 'sha256',
        canonicalization: 'mosga-replay-canonical-json-v1',
        entries: [
          {
            path: 'native/transcript.jsonl',
            mediaType: 'application/jsonl',
            byteLength: 2,
            digest,
          },
        ],
        contentHash: digest,
      }).contentHash,
    ).toBe(digest);
    expect(
      ReplayBundleIntegritySchema.safeParse({
        algorithm: 'sha256',
        canonicalization: 'mosga-replay-canonical-json-v1',
        entries: [],
        contentHash: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
});

describe('complete ReplayBundle v1 contract', () => {
  function fakeBundle() {
    const digest = `sha256:${'a'.repeat(64)}`;
    return {
      payload: fakeReviewedPayload(),
      integrity: {
        algorithm: 'sha256' as const,
        canonicalization: 'mosga-replay-canonical-json-v1' as const,
        entries: [
          {
            path: 'instructions/workspace/CLAUDE.md',
            mediaType: 'text/markdown; charset=utf-8' as const,
            byteLength: 28,
            digest,
          },
          {
            path: 'native/transcript.jsonl',
            mediaType: 'application/jsonl' as const,
            byteLength: 64,
            digest,
          },
        ],
        contentHash: digest,
      },
    };
  }

  it('parses every complete typed v1 field and keeps source/target models distinct', () => {
    const parsed = ReplayBundleSchema.parse(fakeBundle());
    expect(parsed.payload.source.sourceModels).toEqual(['source-model-a']);
    expect(parsed.payload.source.modelTimeline[0]?.model).toBe('source-model-a');
    expect(parsed.payload.delivery.targetModel).toBe('different-target-model');
    expect(parsed.payload.terminalManifestSeed.delivery.targetModel).toBe(
      'different-target-model',
    );
  });

  it('rejects unsupported versions and policy values', () => {
    const unsupportedVersion = fakeBundle();
    (unsupportedVersion.payload as { schemaVersion: string }).schemaVersion = '2.0.0';
    expect(ReplayBundleSchema.safeParse(unsupportedVersion).success).toBe(false);

    const unsupportedPolicy = fakeBundle();
    (
      unsupportedPolicy.payload.runtimePolicy as { replayMode: string }
    ).replayMode = 'reconstructed-api';
    expect(ReplayBundleSchema.safeParse(unsupportedPolicy).success).toBe(false);
  });

  it('rejects forbidden extra runtime secrets at every strict boundary', () => {
    const withPayloadKey = fakeBundle();
    (
      withPayloadKey.payload as typeof withPayloadKey.payload & {
        upstreamApiKey: string;
      }
    ).upstreamApiKey = 'obviously-fake-key';
    expect(ReplayBundleSchema.safeParse(withPayloadKey).success).toBe(false);

    const withRouteToken = fakeBundle();
    (
      withRouteToken.payload.runtimePolicy as typeof withRouteToken.payload.runtimePolicy & {
        routeToken: string;
      }
    ).routeToken = 'obviously-fake-route-token';
    expect(ReplayBundleSchema.safeParse(withRouteToken).success).toBe(false);
  });
});

describe('REPLAY_BUNDLE.md schema anti-drift', () => {
  const doc = readFileSync(
    path.join(here, '..', '..', 'REPLAY_BUNDLE.md'),
    'utf8',
  );

  function tableFields(heading: string): string[] {
    const start = doc.indexOf(`## ${heading}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const tail = doc.slice(start + heading.length + 3);
    const nextHeading = tail.indexOf('\n## ');
    const section = nextHeading >= 0 ? tail.slice(0, nextHeading) : tail;
    return section
      .split('\n')
      .filter((line) => /^\| `[^`]+` \|/.test(line))
      .map((line) => line.split('|')[1]!.trim().replaceAll('`', ''));
  }

  it('documents every ReplayBundle core field exactly once', () => {
    expect(tableFields('ReplayBundle fields')).toEqual(
      Object.keys(ReplayBundleSchema.shape),
    );
    expect(tableFields('ReplayBundlePayload fields')).toEqual(
      Object.keys(ReplayBundlePayloadSchema.shape),
    );
    expect(tableFields('ReplayBundleIntegrity fields')).toEqual(
      Object.keys(ReplayBundleIntegritySchema.shape),
    );
  });

  it('documents the versioned, domain-separated, self-reference-free boundary', () => {
    expect(doc).toContain('mosga-replay-canonical-json-v1');
    expect(doc).toContain('mosga-replay-bundle:v1');
    expect(doc).toContain('`integrity.contentHash` is outside');
    expect(doc).toContain('legacy unprefixed');
  });
});
