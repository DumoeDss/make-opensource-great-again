import { z } from 'zod';

import { SourceCliSchema } from './envelope.js';

export const REPLAY_SCHEMA_VERSION = '1.0.0' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const JsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), JsonObjectSchema]),
);
export const JsonArraySchema: z.ZodType<JsonArray> = z.array(JsonValueSchema);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);

export const NativeJsonlRowSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    value: JsonObjectSchema,
  })
  .strict();
export type NativeJsonlRow = z.infer<typeof NativeJsonlRowSchema>;

export const NativeJsonlFileSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['primary', 'auxiliary']),
    logicalPath: z.string().min(1),
    rows: z.array(NativeJsonlRowSchema).min(1),
  })
  .strict()
  .superRefine((file, context) => {
    const ordinals = new Set<number>();
    file.rows.forEach((row, index) => {
      if (ordinals.has(row.ordinal)) {
        context.addIssue({
          code: 'custom',
          path: ['rows', index, 'ordinal'],
          message: 'Native JSONL row ordinals must be unique within a file.',
        });
      }
      ordinals.add(row.ordinal);
    });
  });
export type NativeJsonlFile = z.infer<typeof NativeJsonlFileSchema>;

export const NativeSessionArtifactSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    sourceCli: SourceCliSchema,
    sourceFormat: z.enum(['claude-code-jsonl', 'codex-jsonl']),
    sessionIdAlias: z.string().min(1),
    files: z.array(NativeJsonlFileSchema).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const fileIds = new Set<string>();
    artifact.files.forEach((file, index) => {
      if (fileIds.has(file.id)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'id'],
          message: 'Native session file ids must be unique.',
        });
      }
      fileIds.add(file.id);
    });
  });
export type NativeSessionArtifact = z.infer<typeof NativeSessionArtifactSchema>;

export const SourceModelTimelineEntrySchema = z
  .object({
    assistantTurnIndex: z.number().int().nonnegative(),
    model: z.string().min(1),
    effort: z.string().min(1).nullable(),
  })
  .strict();
export type SourceModelTimelineEntry = z.infer<
  typeof SourceModelTimelineEntrySchema
>;

export const SafeSourceSummarySchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    sourceCli: SourceCliSchema,
    sourceFormat: z.enum(['claude-code-jsonl', 'codex-jsonl']),
    sessionIdAlias: z.string().min(1),
    recordedCliVersion: z.string().min(1).nullable(),
    modelProvider: z.string().min(1).nullable(),
    sourceModels: z.array(z.string().min(1)),
    modelTimeline: z.array(SourceModelTimelineEntrySchema),
    contextWindow: z.number().int().positive().nullable(),
    sessionMode: z.enum(['interactive', 'non-interactive', 'unknown']),
    entrypoint: z.enum(['terminal', 'ide', 'api', 'unknown']),
  })
  .strict();
export type SafeSourceSummary = z.infer<typeof SafeSourceSummarySchema>;

export const ReplayTrajectorySchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    totalRows: z.number().int().nonnegative(),
    userTurns: z.number().int().nonnegative(),
    assistantTurns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    toolResults: z.number().int().nonnegative(),
    compactedEvents: z.number().int().nonnegative(),
  })
  .strict();
export type ReplayTrajectory = z.infer<typeof ReplayTrajectorySchema>;

export const NativeCaptureErrorCodeSchema = z.enum([
  'missing-file',
  'unreadable-file',
  'empty-session',
  'malformed-jsonl',
  'non-object-row',
  'unsupported-format',
  'unsupported-compression',
]);
export type NativeCaptureErrorCode = z.infer<
  typeof NativeCaptureErrorCodeSchema
>;

export const NativeCaptureErrorSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    sourceCli: SourceCliSchema,
    code: NativeCaptureErrorCodeSchema,
    message: z.string().min(1),
  })
  .strict();
export type NativeCaptureError = z.infer<typeof NativeCaptureErrorSchema>;

export const NativeCaptureSuccessSchema = z
  .object({
    ok: z.literal(true),
    artifact: NativeSessionArtifactSchema,
    source: SafeSourceSummarySchema,
    trajectory: ReplayTrajectorySchema,
  })
  .strict();
export type NativeCaptureSuccess = z.infer<
  typeof NativeCaptureSuccessSchema
>;

export const NativeCaptureFailureSchema = z
  .object({
    ok: z.literal(false),
    error: NativeCaptureErrorSchema,
  })
  .strict();
export type NativeCaptureFailure = z.infer<
  typeof NativeCaptureFailureSchema
>;

export const NativeCaptureResultSchema = z.discriminatedUnion('ok', [
  NativeCaptureSuccessSchema,
  NativeCaptureFailureSchema,
]);
export type NativeCaptureResult = z.infer<typeof NativeCaptureResultSchema>;

export const InstructionKindSchema = z.enum(['claude-md', 'agents-md']);
export type InstructionKind = z.infer<typeof InstructionKindSchema>;

export const InstructionCandidateSchema = z
  .object({
    sourcePath: z.string().min(1),
    kind: InstructionKindSchema,
    stagePath: z.string().min(1),
    effectiveOrder: z.number().int().nonnegative(),
    content: z.union([z.string(), z.instanceof(Uint8Array)]),
  })
  .strict();
export type InstructionCandidate = z.infer<typeof InstructionCandidateSchema>;

export const InstructionSnapshotFileSchema = z
  .object({
    id: z.string().min(1),
    kind: InstructionKindSchema,
    stagePath: z.string().min(1),
    effectiveOrder: z.number().int().nonnegative(),
    content: z.string(),
  })
  .strict();
export type InstructionSnapshotFile = z.infer<
  typeof InstructionSnapshotFileSchema
>;

export const InstructionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    files: z.array(InstructionSnapshotFileSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const instructionIds = new Set<string>();
    snapshot.files.forEach((file, index) => {
      if (instructionIds.has(file.id)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'id'],
          message: 'Instruction snapshot file ids must be unique.',
        });
      }
      instructionIds.add(file.id);
    });
  });
export type InstructionSnapshot = z.infer<typeof InstructionSnapshotSchema>;

export const ReplayOmissionReasonSchema = z.enum([
  'not-approved',
  'unavailable',
  'unsupported',
  'excluded-by-policy',
  'removed-after-review',
  'not-recorded',
]);
export type ReplayOmissionReason = z.infer<
  typeof ReplayOmissionReasonSchema
>;

export const ReplayOmissionSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum([
      'instruction',
      'source-context',
      'opaque-content',
      'other',
    ]),
    reason: ReplayOmissionReasonSchema,
    disclosure: z.string().min(1),
    relatedId: z.string().min(1).nullable(),
  })
  .strict();
export type ReplayOmission = z.infer<typeof ReplayOmissionSchema>;

export const ReplayModeV1Schema = z.literal('cli-resume');
export type ReplayModeV1 = z.infer<typeof ReplayModeV1Schema>;

export const InstructionPolicyV1Schema = z.literal('sanitized-snapshot');
export type InstructionPolicyV1 = z.infer<typeof InstructionPolicyV1Schema>;

export const SkillPolicyV1Schema = z.literal('cli-discovery-read-only');
export type SkillPolicyV1 = z.infer<typeof SkillPolicyV1Schema>;

export const ReplayRuntimePolicySchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    replayMode: ReplayModeV1Schema,
    instructionPolicy: InstructionPolicyV1Schema,
    skillPolicy: SkillPolicyV1Schema,
    proxyRescan: z.literal(false),
    maxInferenceRequests: z.literal(1),
    projectAlias: z.string().min(1),
    workingDirectoryAlias: z.string().min(1),
  })
  .strict();
export type ReplayRuntimePolicy = z.infer<typeof ReplayRuntimePolicySchema>;

export const ReplayDeliveryTargetSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    targetProviderId: z.string().min(1),
    targetModel: z.string().min(1),
  })
  .strict();
export type ReplayDeliveryTarget = z.infer<
  typeof ReplayDeliveryTargetSchema
>;

export const SanitizationProvenanceSchema = z
  .object({
    rulesetVersion: z.string().min(1),
    reportVersion: z.string().min(1),
    sanitizerPackageVersion: z.string().min(1),
  })
  .strict();
export type SanitizationProvenance = z.infer<
  typeof SanitizationProvenanceSchema
>;

export const TerminalManifestSeedSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    kind: z.literal('mosga-replay-terminal-manifest-seed'),
    purpose: z.literal('open-source-contribution'),
    source: SafeSourceSummarySchema,
    trajectory: ReplayTrajectorySchema,
    sanitization: SanitizationProvenanceSchema,
    omissionPolicy: z.literal('explicit-known-omissions'),
    replayMode: ReplayModeV1Schema,
    instructionPolicy: InstructionPolicyV1Schema,
    skillPolicy: SkillPolicyV1Schema,
    proxyRescan: z.literal(false),
    maxInferenceRequests: z.literal(1),
    delivery: ReplayDeliveryTargetSchema,
  })
  .strict();
export type TerminalManifestSeed = z.infer<
  typeof TerminalManifestSeedSchema
>;

export const ReplaySpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((span) => span.end >= span.start, {
    message: 'span end must be greater than or equal to span start',
  });
export type ReplaySpan = z.infer<typeof ReplaySpanSchema>;

export const ReplayNativeFindingLocationSchema = z
  .object({
    kind: z.literal('native'),
    fileId: z.string().min(1),
    rowOrdinal: z.number().int().nonnegative(),
    jsonPointer: z.string(),
    span: ReplaySpanSchema,
  })
  .strict();
export type ReplayNativeFindingLocation = z.infer<
  typeof ReplayNativeFindingLocationSchema
>;

export const ReplayInstructionFindingLocationSchema = z
  .object({
    kind: z.literal('instruction'),
    instructionId: z.string().min(1),
    span: ReplaySpanSchema,
  })
  .strict();
export type ReplayInstructionFindingLocation = z.infer<
  typeof ReplayInstructionFindingLocationSchema
>;

export const ReplayMetadataFindingLocationSchema = z
  .object({
    kind: z.literal('metadata'),
    fieldPath: z.string().min(1),
    span: ReplaySpanSchema,
  })
  .strict();
export type ReplayMetadataFindingLocation = z.infer<
  typeof ReplayMetadataFindingLocationSchema
>;

export const ReplayFindingLocationSchema = z.discriminatedUnion('kind', [
  ReplayNativeFindingLocationSchema,
  ReplayInstructionFindingLocationSchema,
  ReplayMetadataFindingLocationSchema,
]);
export type ReplayFindingLocation = z.infer<
  typeof ReplayFindingLocationSchema
>;

export const ReplayFindingDispositionSchema = z.enum([
  'pending',
  'replace',
  'delete',
  'allow',
]);
export type ReplayFindingDisposition = z.infer<
  typeof ReplayFindingDispositionSchema
>;

export const ReplayFindingSchema = z
  .object({
    id: z.string().min(1),
    layer: z.enum(['secrets', 'custom', 'normalization', 'guard']),
    ruleId: z.string().min(1),
    category: z.string().min(1).nullable(),
    location: ReplayFindingLocationSchema,
    matchPreview: z.string(),
    matchHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    replacementSuggestion: z.string(),
    disposition: ReplayFindingDispositionSchema,
    blocking: z.boolean(),
  })
  .strict();
export type ReplayFinding = z.infer<typeof ReplayFindingSchema>;

export const ReplayOpaqueLocationSchema = z
  .object({
    kind: z.literal('native'),
    fileId: z.string().min(1),
    rowOrdinal: z.number().int().nonnegative(),
    jsonPointer: z.string(),
  })
  .strict();
export type ReplayOpaqueLocation = z.infer<
  typeof ReplayOpaqueLocationSchema
>;

export const ReplayOpaqueDispositionSchema = z.enum([
  'pending',
  'keep',
  'remove',
  'replace',
]);
export type ReplayOpaqueDisposition = z.infer<
  typeof ReplayOpaqueDispositionSchema
>;

export const ReplayOpaqueItemSchema = z
  .object({
    id: z.string().min(1),
    location: ReplayOpaqueLocationSchema,
    blockType: z.string().min(1),
    matchPreview: z.string(),
    disposition: ReplayOpaqueDispositionSchema,
    replacement: JsonValueSchema.nullable(),
  })
  .strict();
export type ReplayOpaqueItem = z.infer<typeof ReplayOpaqueItemSchema>;

export const ReplayDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);
export type ReplayDigest = z.infer<typeof ReplayDigestSchema>;

export const ReplayReviewEvidenceSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
    draftId: z.string().min(1),
    rulesetVersion: z.string().min(1),
    reportVersion: z.string().min(1),
    decisionVersion: z.string().min(1),
    reviewedDraftHash: ReplayDigestSchema,
    findings: z.array(ReplayFindingSchema),
    opaqueItems: z.array(ReplayOpaqueItemSchema),
    approvedAt: z.string().datetime({ offset: true }),
    humanReviewPassed: z.literal(true),
  })
  .strict();
export type ReplayReviewEvidence = z.infer<
  typeof ReplayReviewEvidenceSchema
>;

const replayPayloadBaseShape = {
  schemaVersion: z.literal(REPLAY_SCHEMA_VERSION),
  draftId: z.string().min(1),
  source: SafeSourceSummarySchema,
  nativeSession: NativeSessionArtifactSchema,
  instructionSnapshot: InstructionSnapshotSchema,
  terminalManifestSeed: TerminalManifestSeedSchema,
  runtimePolicy: ReplayRuntimePolicySchema,
  delivery: ReplayDeliveryTargetSchema,
  omissions: z.array(ReplayOmissionSchema),
};

export const ReplayBundleDraftSchema = z
  .object(replayPayloadBaseShape)
  .strict();
export type ReplayBundleDraft = z.infer<typeof ReplayBundleDraftSchema>;

export const ReplayBundlePayloadSchema = z
  .object({
    ...replayPayloadBaseShape,
    review: ReplayReviewEvidenceSchema,
  })
  .strict();
export type ReplayBundlePayload = z.infer<typeof ReplayBundlePayloadSchema>;

export const ReplayIntegrityEntrySchema = z
  .object({
    path: z.string().min(1),
    mediaType: z.enum([
      'application/jsonl',
      'text/markdown; charset=utf-8',
    ]),
    byteLength: z.number().int().nonnegative(),
    digest: ReplayDigestSchema,
  })
  .strict();
export type ReplayIntegrityEntry = z.infer<
  typeof ReplayIntegrityEntrySchema
>;

export const ReplayBundleIntegritySchema = z
  .object({
    algorithm: z.literal('sha256'),
    canonicalization: z.literal('mosga-replay-canonical-json-v1'),
    entries: z.array(ReplayIntegrityEntrySchema),
    contentHash: ReplayDigestSchema,
  })
  .strict();
export type ReplayBundleIntegrity = z.infer<
  typeof ReplayBundleIntegritySchema
>;

export const ReplayBundleSchema = z
  .object({
    payload: ReplayBundlePayloadSchema,
    integrity: ReplayBundleIntegritySchema,
  })
  .strict();
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;
