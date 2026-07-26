import { describe, expect, it } from 'vitest';

import { PseudonymMapper } from '../pseudonym.js';
import { applyReplayDispositions } from '../replayApply.js';
import { scanReplayDraft } from '../replayScan.js';
import type { CompiledRuleset } from '../schemas.js';
import { makeReplayDraft } from './replay-fixtures.js';

const AT = '2026-07-27T00:00:00.000Z';
const CANARY = 'BLOCKING_REPLAY_CANARY';
const REPLACEMENT_CANARY = 'REPLACEMENT_CREATED_CANARY';
const PREFIX_CANARY = 'PREFIX_CANARY';
const ALLOWED_CANARY = 'ALLOWED_CANARY';

function ruleset(
  pattern: string | null = CANARY,
  replacement = '<REDACTED>',
): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules:
      pattern === null
        ? []
        : [
            {
              id: 'replay-canary',
              kind: 'literal',
              pattern,
              replacement,
            },
          ],
    degraded: [],
  };
}

function options(activeRuleset: CompiledRuleset) {
  return {
    ruleset: activeRuleset,
    expectedRulesetVersion: 'rules-1',
    decisionVersion: 'decisions-1',
    approvedAt: AT,
  };
}

function replacementCanaryRuleset(): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: [
      {
        id: 'original-canary',
        kind: 'literal',
        pattern: CANARY,
        replacement: REPLACEMENT_CANARY,
      },
      {
        id: 'replacement-canary',
        kind: 'literal',
        pattern: REPLACEMENT_CANARY,
        replacement: '<REDACTED>',
      },
    ],
    degraded: [],
  };
}

function mixedDecisionRuleset(
  prefixReplacement = '<REDACTED>',
): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: [
      {
        id: 'prefix-canary',
        kind: 'literal',
        pattern: PREFIX_CANARY,
        replacement: prefixReplacement,
      },
      {
        id: 'allowed-canary',
        kind: 'literal',
        pattern: ALLOWED_CANARY,
        replacement: '<REDACTED>',
      },
    ],
    degraded: [],
  };
}

function duplicateAllowedMappingRuleset(): CompiledRuleset {
  const duplicateRule = {
    id: 'replay-canary',
    kind: 'literal' as const,
    pattern: CANARY,
    replacement: '<REDACTED>',
  };
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: [
      structuredClone(duplicateRule),
      structuredClone(duplicateRule),
    ],
    degraded: [],
  };
}

function overlappingDecisionRuleset(): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: [
      {
        id: 'outer-canary',
        kind: 'literal',
        pattern: PREFIX_CANARY,
        replacement: '<REDACTED>',
      },
      {
        id: 'inner-canary',
        kind: 'literal',
        pattern: 'FIX_CANARY',
        replacement: '<REDACTED>',
      },
    ],
    degraded: [],
  };
}

describe('applyReplayDispositions identity and verification', () => {
  it('returns an immutable preview but no payload while the recomputed gate is locked', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = ruleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const before = structuredClone(draft);

    const result = applyReplayDispositions(
      draft,
      scan.report,
      scan.mapper,
      options(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gate).toMatchObject({
      blockingPending: 1,
      unlocked: false,
    });
    expect(result.sealablePayload).toBeNull();
    expect(result.draft).toEqual(before);
    expect(draft).toEqual(before);
  });

  it('rejects draft id, draft content, and independently expected ruleset mismatches', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = ruleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    expect(
      applyReplayDispositions(
        draft,
        { ...scan.report, draftId: 'other-draft' },
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'draft-id-mismatch' },
    });

    const staleDraft = structuredClone(draft);
    staleDraft.instructionSnapshot.files[0]!.content += '-changed';
    expect(
      applyReplayDispositions(
        staleDraft,
        scan.report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'draft-content-mismatch' },
    });

    expect(
      applyReplayDispositions(draft, scan.report, scan.mapper, {
        ...options(activeRuleset),
        expectedRulesetVersion: 'untrusted-report-version',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'ruleset-mismatch' },
    });
  });

  it('applies resolved edits, validates the output, and unlocks only after verification', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = `before ${CANARY} after`;
    const activeRuleset = ruleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: finding.blocking
        ? ('replace' as const)
        : finding.disposition,
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gate.unlocked).toBe(true);
    expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
      'before <REDACTED> after',
    );
    expect(result.sealablePayload).not.toBeNull();
  });

  it('fails closed when a replace decision leaves the same blocking canary', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = ruleset(CANARY, CANARY);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: 'replace' as const,
    }));

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'surviving-blocking-canary' },
    });
  });

  it('fails closed when a replacement creates a different blocking finding', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    draft.omissions[0]!.disclosure =
      'Excluded /Users/private/repository';
    const activeRuleset = replacementCanaryRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: finding.blocking
        ? ('replace' as const)
        : finding.disposition,
    }));

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'surviving-blocking-canary' },
    });
  });

  it('permits only an unchanged blocking finding with an exact allow decision', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = ruleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: 'allow' as const,
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sealablePayload).not.toBeNull();
  });

  it.each([
    {
      name: 'shorter replace',
      disposition: 'replace' as const,
      replacement: 'X',
    },
    {
      name: 'longer replace',
      disposition: 'replace' as const,
      replacement: 'SAFE_PREFIX_REPLACEMENT_THAT_IS_LONGER',
    },
    {
      name: 'delete',
      disposition: 'delete' as const,
      replacement: '',
    },
  ])(
    'projects an exact allow through a preceding $name decision',
    ({ disposition, replacement }) => {
      const draft = makeReplayDraft();
      draft.instructionSnapshot.files[0]!.content =
        `${PREFIX_CANARY} + ${ALLOWED_CANARY}`;
      const activeRuleset = mixedDecisionRuleset(replacement);
      const scan = scanReplayDraft(draft, activeRuleset, {
        generatedAt: AT,
      });
      expect(scan.ok).toBe(true);
      if (!scan.ok) return;
      const report = structuredClone(scan.report);
      report.findings = report.findings.map((finding) =>
        finding.ruleId === 'prefix-canary'
          ? {
              ...finding,
              disposition,
            }
          : {
              ...finding,
              disposition: 'allow' as const,
            },
      );

      const result = applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
        `${replacement} + ${ALLOWED_CANARY}`,
      );
      expect(result.sealablePayload).not.toBeNull();
    },
  );

  it('does not shift an exact allow for a later edit in the same string', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content =
      `${ALLOWED_CANARY} + ${PREFIX_CANARY}`;
    const replacement = 'SAFE_PREFIX_REPLACEMENT_THAT_IS_LONGER';
    const activeRuleset = mixedDecisionRuleset(replacement);
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) =>
      finding.ruleId === 'prefix-canary'
        ? {
            ...finding,
            disposition: 'replace' as const,
          }
        : {
            ...finding,
            disposition: 'allow' as const,
          },
    );

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
      `${ALLOWED_CANARY} + ${replacement}`,
    );
    expect(result.sealablePayload).not.toBeNull();
  });

  it('rejects an allowed span that overlaps a selected edit', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = PREFIX_CANARY;
    const activeRuleset = overlappingDecisionRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition:
        finding.ruleId === 'outer-canary'
          ? ('replace' as const)
          : ('allow' as const),
    }));

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-finding',
        message: expect.stringContaining('overlaps a selected edit'),
      },
    });
  });

  it('rejects duplicate allowed mappings as ambiguous', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = duplicateAllowedMappingRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: 'allow' as const,
    }));

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-finding',
        message: expect.stringContaining(
          'map to the same verification finding',
        ),
      },
    });
  });

  it('rejects duplicate coordinates at the public apply boundary', () => {
    const draft = makeReplayDraft();
    const activeRuleset = ruleset(null);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const ambiguous = structuredClone(draft);
    ambiguous.nativeSession.files.push({
      id: 'transcript',
      role: 'auxiliary',
      logicalPath: 'native/second-session.jsonl',
      rows: [{ ordinal: 0, value: { secret: 'UNTOUCHED_CANARY' } }],
    });

    expect(
      applyReplayDispositions(
        ambiguous,
        scan.report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-draft' },
    });
  });

  it('redacts path previews and withholds sealing while privacy findings remain', () => {
    const draft = makeReplayDraft();
    const nativePath = '/Users/private/repository';
    const instructionPath = '/Users/instruction/private';
    const metadataPath = '/Users/metadata/private';
    draft.nativeSession.files[0]!.rows[0]!.value = {
      type: 'meta',
      cwd: nativePath,
    };
    draft.instructionSnapshot.files[0]!.content =
      `Read ${instructionPath}`;
    draft.omissions[0]!.disclosure = `Excluded ${metadataPath}`;
    const activeRuleset = ruleset(null);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const serializedReport = JSON.stringify(scan.report);
    for (const originalPath of [
      nativePath,
      instructionPath,
      metadataPath,
    ]) {
      expect(serializedReport).not.toContain(originalPath);
    }
    expect(scan.report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'normalization',
          category: 'path',
          matchPreview: expect.stringContaining('redacted'),
        }),
      ]),
    );
    expect(scan.report.gate.unlocked).toBe(true);

    const unresolved = applyReplayDispositions(
      draft,
      scan.report,
      scan.mapper,
      options(activeRuleset),
    );
    expect(unresolved.ok).toBe(true);
    if (!unresolved.ok) return;
    expect(unresolved.sealablePayload).toBeNull();
    expect(JSON.stringify(unresolved.draft)).toContain(nativePath);
  });

  it('rejects a report paired with a different replay pseudonym mapper', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content =
      'Use /Users/fake/repository';
    const activeRuleset = ruleset(null);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    expect(
      applyReplayDispositions(
        draft,
        scan.report,
        new PseudonymMapper(),
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'mapper-mismatch' },
    });
  });
});

describe('replay review evidence', () => {
  it('stamps versioned redacted decisions and human approval on an unlocked payload', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = CANARY;
    const activeRuleset = ruleset();
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: 'delete' as const,
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.sealablePayload === null) return;
    expect(result.sealablePayload.review).toMatchObject({
      schemaVersion: '1.0.0',
      draftId: 'draft-1',
      rulesetVersion: 'rules-1',
      reportVersion: '1.0.0',
      decisionVersion: 'decisions-1',
      approvedAt: AT,
      humanReviewPassed: true,
    });
    expect(result.sealablePayload.review.findings[0]).toMatchObject({
      disposition: 'delete',
      matchPreview: '[redacted:custom:replay-canary]',
    });
    expect(JSON.stringify(result.sealablePayload.review)).not.toContain(
      CANARY,
    );
  });

  it('records an opaque decision without copying replacement bytes into review evidence', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      type: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            data: 'FAKE_OPAQUE_SOURCE_BYTES',
          },
        },
      ],
    };
    const activeRuleset = ruleset(null);
    const scan = scanReplayDraft(draft, activeRuleset, { generatedAt: AT });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.opaqueItems = report.opaqueItems.map((item) => ({
      ...item,
      disposition: 'replace' as const,
      replacement: {
        type: 'text',
        text: 'SAFE_REPLACEMENT_BYTES',
      },
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.sealablePayload === null) return;
    expect(result.sealablePayload.review.opaqueItems).toEqual([
      expect.objectContaining({
        disposition: 'replace',
        matchPreview: '[opaque:image]',
        replacement: null,
      }),
    ]);
    const evidence = JSON.stringify(result.sealablePayload.review);
    expect(evidence).not.toContain('FAKE_OPAQUE_SOURCE_BYTES');
    expect(evidence).not.toContain('SAFE_REPLACEMENT_BYTES');
  });
});
