import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  InstructionCandidateSchema,
  InstructionSnapshotSchema,
  NativeCaptureSuccessSchema,
  ReplayBundleDraftSchema,
  ReplayDeliveryTargetSchema,
  ReplayOmissionSchema,
  ReplayRuntimePolicySchema,
  TerminalManifestSeedSchema,
} from '@mosga/contracts';
import type {
  InstructionCandidate,
  InstructionSnapshot,
  NativeCaptureSuccess,
  ReplayBundleDraft,
  ReplayDeliveryTarget,
  ReplayOmission,
  ReplayRuntimePolicy,
  TerminalManifestSeed,
} from '@mosga/contracts';

export type ReplayDraftErrorCode =
  | 'invalid-instruction-candidate'
  | 'invalid-instruction-utf8'
  | 'unsafe-instruction-stage-path'
  | 'duplicate-instruction-stage-path'
  | 'invalid-draft-input';

class ReplayDraftConstructionError extends Error {
  constructor(
    readonly code: ReplayDraftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayDraftConstructionError';
  }
}

export interface CreateReplayDraftInput {
  draftId: string;
  nativeCapture: NativeCaptureSuccess;
  instructionCandidates: InstructionCandidate[];
  terminalManifestSeed: TerminalManifestSeed;
  runtimePolicy: ReplayRuntimePolicy;
  delivery: ReplayDeliveryTarget;
  omissions: ReplayOmission[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateStagePath(
  stagePath: string,
  kind: InstructionCandidate['kind'],
): void {
  const unsafe =
    stagePath.length === 0 ||
    stagePath.includes('\0') ||
    stagePath.includes('\\') ||
    stagePath.startsWith('/') ||
    /^[A-Za-z]:/.test(stagePath);
  const segments = stagePath.split('/');
  const hasUnsafeSegment = segments.some(
    (segment) =>
      segment.length === 0 || segment === '.' || segment === '..',
  );
  const basename = segments.at(-1);
  const expectedBasename =
    kind === 'claude-md' ? 'CLAUDE.md' : 'AGENTS.md';
  if (unsafe || hasUnsafeSegment || basename !== expectedBasename) {
    throw new ReplayDraftConstructionError(
      'unsafe-instruction-stage-path',
      'Instruction stagePath must be a safe relative POSIX path with a matching recognized basename.',
    );
  }
}

function decodeInstructionContent(
  content: InstructionCandidate['content'],
): string {
  let decoded: string;
  if (typeof content === 'string') {
    decoded = content;
  } else {
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new ReplayDraftConstructionError(
        'invalid-instruction-utf8',
        'Instruction content is not valid UTF-8.',
      );
    }
  }
  return decoded.replace(/\r\n?/g, '\n');
}

function instructionId(
  kind: InstructionCandidate['kind'],
  stagePath: string,
  effectiveOrder: number,
  content: string,
): string {
  const hash = createHash('sha256')
    .update('mosga-replay-instruction:v1\0')
    .update(kind)
    .update('\0')
    .update(stagePath)
    .update('\0')
    .update(String(effectiveOrder))
    .update('\0')
    .update(content)
    .digest('hex')
    .slice(0, 24);
  return `instruction-${hash}`;
}

/**
 * Convert private instruction candidates into the public, aliased snapshot.
 * Original source paths are validated as input but never copied or hashed.
 */
export function buildInstructionSnapshot(
  input: InstructionCandidate[],
): InstructionSnapshot {
  const candidates = input.map((candidate) => {
    const parsed = InstructionCandidateSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ReplayDraftConstructionError(
        'invalid-instruction-candidate',
        'An instruction candidate is invalid.',
      );
    }
    validateStagePath(parsed.data.stagePath, parsed.data.kind);
    const content = decodeInstructionContent(parsed.data.content);
    return {
      id: instructionId(
        parsed.data.kind,
        parsed.data.stagePath,
        parsed.data.effectiveOrder,
        content,
      ),
      kind: parsed.data.kind,
      stagePath: parsed.data.stagePath,
      effectiveOrder: parsed.data.effectiveOrder,
      content,
    };
  });

  candidates.sort(
    (left, right) =>
      left.effectiveOrder - right.effectiveOrder ||
      compareText(left.stagePath, right.stagePath),
  );
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1]!.stagePath === candidates[index]!.stagePath) {
      throw new ReplayDraftConstructionError(
        'duplicate-instruction-stage-path',
        'Instruction stagePath values must be unique.',
      );
    }
  }

  return InstructionSnapshotSchema.parse({
    schemaVersion: '1.0.0',
    files: candidates,
  });
}

/** Pure construction from explicit captured inputs; performs no discovery. */
export function createReplayDraft(
  input: CreateReplayDraftInput,
): ReplayBundleDraft {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.draftId !== 'string' ||
    input.draftId.length === 0 ||
    !Array.isArray(input.instructionCandidates) ||
    !Array.isArray(input.omissions)
  ) {
    throw new ReplayDraftConstructionError(
      'invalid-draft-input',
      'ReplayBundle draft construction input is invalid.',
    );
  }

  const capture = NativeCaptureSuccessSchema.safeParse(
    input.nativeCapture,
  );
  const terminalManifestSeed = TerminalManifestSeedSchema.safeParse(
    input.terminalManifestSeed,
  );
  const runtimePolicy = ReplayRuntimePolicySchema.safeParse(
    input.runtimePolicy,
  );
  const delivery = ReplayDeliveryTargetSchema.safeParse(input.delivery);
  const omissions = input.omissions.map((omission) =>
    ReplayOmissionSchema.safeParse(omission),
  );
  if (
    !capture.success ||
    !terminalManifestSeed.success ||
    !runtimePolicy.success ||
    !delivery.success ||
    omissions.some((omission) => !omission.success)
  ) {
    throw new ReplayDraftConstructionError(
      'invalid-draft-input',
      'ReplayBundle draft construction input is invalid.',
    );
  }

  const { artifact, source, trajectory } = capture.data;
  const seed = terminalManifestSeed.data;
  const policy = runtimePolicy.data;
  const target = delivery.data;
  const identitiesMatch =
    artifact.sourceCli === source.sourceCli &&
    artifact.sourceFormat === source.sourceFormat &&
    artifact.sessionIdAlias === source.sessionIdAlias &&
    isDeepStrictEqual(seed.source, source) &&
    isDeepStrictEqual(seed.trajectory, trajectory) &&
    isDeepStrictEqual(seed.delivery, target) &&
    seed.replayMode === policy.replayMode &&
    seed.instructionPolicy === policy.instructionPolicy &&
    seed.skillPolicy === policy.skillPolicy &&
    seed.proxyRescan === policy.proxyRescan &&
    seed.maxInferenceRequests === policy.maxInferenceRequests;
  if (!identitiesMatch) {
    throw new ReplayDraftConstructionError(
      'invalid-draft-input',
      'Captured source, terminal seed, runtime policy, and delivery identities must match.',
    );
  }

  const instructionSnapshot = buildInstructionSnapshot(
    input.instructionCandidates,
  );
  const parsed = ReplayBundleDraftSchema.safeParse({
    schemaVersion: '1.0.0',
    draftId: input.draftId,
    source,
    nativeSession: artifact,
    instructionSnapshot,
    terminalManifestSeed: seed,
    runtimePolicy: policy,
    delivery: target,
    omissions: omissions.map((omission) => {
      if (!omission.success) {
        throw new ReplayDraftConstructionError(
          'invalid-draft-input',
          'ReplayBundle omission input is invalid.',
        );
      }
      return omission.data;
    }),
  });
  if (!parsed.success) {
    throw new ReplayDraftConstructionError(
      'invalid-draft-input',
      'Constructed ReplayBundle draft is invalid.',
    );
  }
  return structuredClone(parsed.data);
}
