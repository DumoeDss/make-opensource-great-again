import { describe, expect, it } from 'vitest';

import type {
  ReplayBundlePayload,
  ReplayBundleDraft,
} from '@mosga/contracts';
import {
  applyReplayDispositions,
  scanReplayDraft,
  type CompiledRuleset,
} from '@mosga/sanitizer';

import { createReplayDraft } from '../draft.js';
import {
  computeReplayBundleContentHash,
  deriveReplayIntegrityEntries,
  sealReplayBundle,
  validateReplayBundle,
  type ReplayBundleIntegrityErrorCode,
} from '../integrity.js';
import { makeCreateDraftInput } from './fixtures.js';

const AT = '2026-07-27T00:00:00.000Z';
const ORIGINAL_CANARY = 'ORIGINAL_REVIEW_CANARY';
const REPLACEMENT_SOURCE_CANARY =
  'POST_APPLY_REPLACEMENT_SOURCE';
const POST_APPLY_BLOCKING_CANARY =
  'POST_APPLY_BLOCKING_CANARY';

const activeRuleset: CompiledRuleset = {
  rulesetVersion: 'rules-1',
  gitleaksVersion: 'fake',
  generatedAt: AT,
  rules: [],
  customRules: [
    {
      id: 'original-review-canary',
      kind: 'literal',
      pattern: ORIGINAL_CANARY,
      replacement: '<REVIEWED_SAFE>',
    },
    {
      id: 'post-apply-replacement-source',
      kind: 'literal',
      pattern: REPLACEMENT_SOURCE_CANARY,
      replacement: POST_APPLY_BLOCKING_CANARY,
    },
    {
      id: 'post-apply-blocking-canary',
      kind: 'literal',
      pattern: POST_APPLY_BLOCKING_CANARY,
      replacement: '<REVIEWED_SAFE>',
    },
  ],
  degraded: [],
};

function makeSuccessfullyAppliedPayload(): ReplayBundlePayload {
  const input = makeCreateDraftInput();
  input.nativeCapture.artifact.files[0]!.rows[0]!.value = {
    type: 'user',
    message: { content: ORIGINAL_CANARY },
  };
  input.omissions.push({
    id: 'omission-2',
    category: 'instruction',
    reason: 'not-approved',
    disclosure: 'A second fake instruction was not approved.',
    relatedId: 'instruction-2',
  });
  const draft = createReplayDraft(input);
  const scan = scanReplayDraft(draft, activeRuleset, {
    generatedAt: AT,
  });
  expect(scan.ok).toBe(true);
  if (!scan.ok) {
    throw new Error('Expected the review-binding fixture scan to pass.');
  }
  expect(scan.report.findings).toHaveLength(1);

  const report = structuredClone(scan.report);
  report.findings[0]!.disposition = 'replace';
  const applied = applyReplayDispositions(
    draft,
    report,
    scan.mapper,
    {
      ruleset: activeRuleset,
      expectedRulesetVersion: 'rules-1',
      decisionVersion: 'decisions-1',
      approvedAt: AT,
    },
  );
  expect(applied.ok).toBe(true);
  if (!applied.ok || applied.sealablePayload === null) {
    throw new Error(
      'Expected the review-binding fixture apply to be sealable.',
    );
  }
  expect(
    (
      applied.sealablePayload.nativeSession.files[0]!.rows[0]!
        .value as { message: { content: string } }
    ).message.content,
  ).toBe('<REVIEWED_SAFE>');
  return applied.sealablePayload;
}

function expectCodeAndNoBundle(
  payload: ReplayBundlePayload,
  code: ReplayBundleIntegrityErrorCode,
): void {
  let bundle: ReturnType<typeof sealReplayBundle> | undefined;
  try {
    bundle = sealReplayBundle(payload);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
  expect(bundle).toBeUndefined();
}

type DraftMutation = (draft: ReplayBundleDraft) => void;

describe('reviewed ReplayBundle draft binding', () => {
  it.each([
    {
      name: 'native row content with a post-apply blocking canary',
      mutate: (draft: ReplayBundleDraft) => {
        (
          draft.nativeSession.files[0]!.rows[0]!.value as {
            message: { content: string };
          }
        ).message.content =
          activeRuleset.customRules.find(
            (rule) => rule.id === 'post-apply-replacement-source',
          )!.replacement;
      },
    },
    {
      name: 'native safe file metadata',
      mutate: (draft: ReplayBundleDraft) => {
        draft.nativeSession.files[0]!.logicalPath =
          'native/renamed-session.jsonl';
      },
    },
    {
      name: 'instruction content',
      mutate: (draft: ReplayBundleDraft) => {
        draft.instructionSnapshot.files[0]!.content =
          'mutated unreviewed instructions';
      },
    },
    {
      name: 'instruction placement metadata',
      mutate: (draft: ReplayBundleDraft) => {
        draft.instructionSnapshot.files[0]!.effectiveOrder = 7;
      },
    },
    {
      name: 'safe source metadata',
      mutate: (draft: ReplayBundleDraft) => {
        draft.source.recordedCliVersion = '9.9.9';
        draft.terminalManifestSeed.source.recordedCliVersion = '9.9.9';
      },
    },
    {
      name: 'terminal manifest seed metadata',
      mutate: (draft: ReplayBundleDraft) => {
        draft.terminalManifestSeed.sanitization.sanitizerPackageVersion =
          '9.9.9';
      },
    },
    {
      name: 'runtime policy',
      mutate: (draft: ReplayBundleDraft) => {
        draft.runtimePolicy.projectAlias = 'mutated-project';
      },
    },
    {
      name: 'delivery',
      mutate: (draft: ReplayBundleDraft) => {
        draft.delivery.targetModel = 'mutated-model';
        draft.terminalManifestSeed.delivery.targetModel =
          'mutated-model';
      },
    },
    {
      name: 'omission content',
      mutate: (draft: ReplayBundleDraft) => {
        draft.omissions[0]!.disclosure =
          'Mutated unreviewed omission disclosure.';
      },
    },
    {
      name: 'omission array order',
      mutate: (draft: ReplayBundleDraft) => {
        draft.omissions.reverse();
      },
    },
    {
      name: 'native row array order',
      mutate: (draft: ReplayBundleDraft) => {
        draft.nativeSession.files[0]!.rows.reverse();
      },
    },
  ])('refuses to seal mutated $name', ({ mutate }) => {
    const payload = structuredClone(
      makeSuccessfullyAppliedPayload(),
    );
    mutate(payload);

    expectCodeAndNoBundle(payload, 'review-content-mismatch');
  });

  it('seals and validates the unchanged successful apply result', () => {
    const payload = makeSuccessfullyAppliedPayload();

    const bundle = sealReplayBundle(payload);

    expect(validateReplayBundle(bundle)).toEqual(payload);
  });

  it('rejects a self-consistent recomputed bundle with a stale review binding', () => {
    const bundle = sealReplayBundle(
      makeSuccessfullyAppliedPayload(),
    );
    (
      bundle.payload.nativeSession.files[0]!.rows[0]!.value as {
        message: { content: string };
      }
    ).message.content = POST_APPLY_BLOCKING_CANARY;
    bundle.integrity.entries = deriveReplayIntegrityEntries(
      bundle.payload,
    );
    bundle.integrity.contentHash = computeReplayBundleContentHash(
      bundle.payload,
      bundle.integrity.entries,
    );

    expect(() => validateReplayBundle(bundle)).toThrowError(
      expect.objectContaining({ code: 'review-content-mismatch' }),
    );
  });
});
