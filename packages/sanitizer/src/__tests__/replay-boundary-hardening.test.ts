import { describe, expect, it } from 'vitest';

import {
  applyReplayDispositions,
  findBlockingReconciliationFailure,
} from '../replayApply.js';
import {
  replayFindingId,
  replayOpaqueItemId,
  scanReplayDraft,
} from '../replayScan.js';
import type {
  CompiledRuleset,
  ReplaySanitizationReport,
} from '../schemas.js';
import { makeReplayDraft } from './replay-fixtures.js';

const AT = '2026-07-27T00:00:00.000Z';
const PREFIX_CANARY = 'PREFIX_CANARY';
const ALLOWED_CANARY = 'ALLOWED_CANARY';

function ruleset(
  customRules: CompiledRuleset['customRules'],
): CompiledRuleset {
  return {
    rulesetVersion: 'rules-1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules,
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

function duplicateAllowedRuleset(): CompiledRuleset {
  const duplicateRule = {
    id: 'duplicate-allowed-canary',
    kind: 'literal' as const,
    pattern: ALLOWED_CANARY,
    replacement: '<REDACTED>',
  };
  return ruleset([
    structuredClone(duplicateRule),
    structuredClone(duplicateRule),
  ]);
}

function allowedRuleset(): CompiledRuleset {
  return ruleset([
    {
      id: 'allowed-canary',
      kind: 'literal',
      pattern: ALLOWED_CANARY,
      replacement: '<REDACTED>',
    },
  ]);
}

function mixedRuleset(
  prefixReplacement = '<REDACTED>',
): CompiledRuleset {
  return ruleset([
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
  ]);
}

describe('replay report trust-boundary attestation', () => {
  it('rejects a reviewed report that omits one of two identical original findings', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = ALLOWED_CANARY;
    const activeRuleset = duplicateAllowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.report.findings).toHaveLength(2);

    const report = structuredClone(scan.report);
    report.findings = [
      { ...report.findings[0]!, disposition: 'allow' },
    ];

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-report' },
    });
  });

  it('never lets one retained approval reconcile two identical verification blockers', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = ALLOWED_CANARY;
    const activeRuleset = duplicateAllowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const approved = {
      ...structuredClone(scan.report.findings[0]!),
      disposition: 'allow' as const,
    };
    const failure = findBlockingReconciliationFailure(
      scan.report.findings,
      [approved],
    );
    expect(failure).toEqual(scan.report.findings[1]);
  });

  it('allows a reviewed blocker to disappear when a neighboring edit changes its regex context', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content =
      `PREFIX_${ALLOWED_CANARY}`;
    const activeRuleset = ruleset([
      {
        id: 'context-prefix',
        kind: 'literal',
        pattern: 'PREFIX_',
        replacement: '<REDACTED>',
      },
      {
        id: 'contextual-allowed-canary',
        kind: 'regex',
        pattern: `(?<=PREFIX_)${ALLOWED_CANARY}`,
        replacement: '<REDACTED>',
      },
    ]);
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.report.findings).toHaveLength(2);

    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition:
        finding.ruleId === 'context-prefix'
          ? ('delete' as const)
          : ('allow' as const),
    }));

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
      ALLOWED_CANARY,
    );
    expect(result.sealablePayload).not.toBeNull();
  });

  it.each([
    {
      name: 'finding identity',
      mutate: (report: ReplaySanitizationReport) => {
        report.findings[0]!.ruleId = 'tampered-rule';
      },
    },
    {
      name: 'finding evidence',
      mutate: (report: ReplaySanitizationReport) => {
        report.findings[0]!.matchPreview = '[tampered-preview]';
      },
    },
    {
      name: 'opaque identity',
      mutate: (report: ReplaySanitizationReport) => {
        report.opaqueItems[0]!.blockType = 'tampered-image';
      },
    },
    {
      name: 'opaque evidence',
      mutate: (report: ReplaySanitizationReport) => {
        report.opaqueItems[0]!.matchPreview = '[tampered-opaque]';
      },
    },
  ])('rejects immutable $name tampering before edits', ({ mutate }) => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        {
          type: 'image',
          data: 'FAKE_IMAGE_BYTES',
          text: ALLOWED_CANARY,
        },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems[0]!.disposition = 'keep';
    mutate(report);
    const before = structuredClone(draft);

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-report' },
    });
    expect(draft).toEqual(before);
  });

  it('accepts legitimate finding and opaque decision-only edits', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        { type: 'image', data: 'FAKE_IMAGE_BYTES' },
        { type: 'text', text: ALLOWED_CANARY },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'delete';
    report.opaqueItems[0]!.disposition = 'replace';
    report.opaqueItems[0]!.replacement = {
      type: 'text',
      text: '[reviewed image omission]',
    };

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
      name: 'finding-only',
      reorder: (report: ReplaySanitizationReport) => {
        report.findings.reverse();
      },
    },
    {
      name: 'opaque-only',
      reorder: (report: ReplaySanitizationReport) => {
        report.opaqueItems.reverse();
      },
    },
    {
      name: 'combined finding and opaque',
      reorder: (report: ReplaySanitizationReport) => {
        report.findings.reverse();
        report.opaqueItems.reverse();
      },
    },
  ])('rejects $name report reordering before edits', ({ reorder }) => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        {
          type: 'image',
          data: 'FIRST_FAKE_IMAGE_BYTES',
          text: PREFIX_CANARY,
        },
        {
          type: 'input_image',
          data: 'SECOND_FAKE_IMAGE_BYTES',
          text: ALLOWED_CANARY,
        },
      ],
    };
    const activeRuleset = mixedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.report.findings).toHaveLength(2);
    expect(scan.report.opaqueItems).toHaveLength(2);

    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition: 'replace' as const,
    }));
    report.opaqueItems = report.opaqueItems.map((item) => ({
      ...item,
      disposition: 'keep' as const,
    }));
    reorder(report);
    const before = structuredClone(draft);

    expect(
      applyReplayDispositions(
        draft,
        report,
        scan.mapper,
        options(activeRuleset),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-report' },
    });
    expect(draft).toEqual(before);
  });
});

describe('allowed JSON Pointer projection through opaque mutations', () => {
  it('seals after removing an earlier opaque array sibling', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        { type: 'image', data: 'FAKE_IMAGE_BYTES' },
        { type: 'text', text: ALLOWED_CANARY },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems[0]!.disposition = 'remove';

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sealablePayload).not.toBeNull();
    expect(
      result.draft.nativeSession.files[0]!.rows[0]!.value,
    ).toEqual({
      content: [{ type: 'text', text: ALLOWED_CANARY }],
    });
  });

  it('projects array indices beneath RFC 6901-escaped object keys', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      'content/list~name': [
        { type: 'image', data: 'FAKE_IMAGE_BYTES' },
        { type: 'text', text: ALLOWED_CANARY },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.report.findings[0]!.location).toMatchObject({
      kind: 'native',
      jsonPointer: '/content~1list~0name/1/text',
    });
    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems[0]!.disposition = 'remove';

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

  it('does not shift a sibling object member when a numeric-looking member is removed', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: {
        '0': { type: 'image', data: 'FAKE_IMAGE_BYTES' },
        '1': { type: 'text', text: ALLOWED_CANARY },
      },
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems[0]!.disposition = 'remove';

    const result = applyReplayDispositions(
      draft,
      report,
      scan.mapper,
      options(activeRuleset),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sealablePayload).not.toBeNull();
    expect(
      result.draft.nativeSession.files[0]!.rows[0]!.value,
    ).toEqual({
      content: {
        '1': { type: 'text', text: ALLOWED_CANARY },
      },
    });
  });

  it('projects through multiple nested earlier opaque removals', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        { type: 'image', data: 'OUTER_FAKE_IMAGE' },
        {
          type: 'container',
          parts: [
            { type: 'image', data: 'FIRST_NESTED_FAKE_IMAGE' },
            {
              type: 'input_image',
              data: 'SECOND_NESTED_FAKE_IMAGE',
            },
            { type: 'text', text: ALLOWED_CANARY },
          ],
        },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems = report.opaqueItems.map((item) => ({
      ...item,
      disposition: 'remove' as const,
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
    expect(
      result.draft.nativeSession.files[0]!.rows[0]!.value,
    ).toEqual({
      content: [
        {
          type: 'container',
          parts: [{ type: 'text', text: ALLOWED_CANARY }],
        },
      ],
    });
  });

  it('does not authorize blocker content created by an ancestor opaque replacement', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        {
          type: 'image',
          data: 'FAKE_IMAGE_BYTES',
          text: ALLOWED_CANARY,
        },
      ],
    };
    const activeRuleset = allowedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings[0]!.disposition = 'allow';
    report.opaqueItems[0]!.disposition = 'replace';
    report.opaqueItems[0]!.replacement = {
      type: 'text',
      text: ALLOWED_CANARY,
    };

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

  it('does not let an ancestor removal transfer approval to shifted replacement-created content', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      content: [
        {
          type: 'image',
          data: 'FAKE_IMAGE_BYTES',
          text: ALLOWED_CANARY,
        },
        { type: 'text', text: PREFIX_CANARY },
      ],
    };
    const activeRuleset = mixedRuleset(ALLOWED_CANARY);
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition:
        finding.ruleId === 'allowed-canary'
          ? ('allow' as const)
          : ('replace' as const),
    }));
    report.opaqueItems[0]!.disposition = 'remove';

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
});

describe('collision-free replay coordinate grouping', () => {
  it('generates distinct finding and opaque ids for delimiter-collision coordinates', () => {
    const firstLocation = {
      kind: 'native' as const,
      fileId: 'a',
      rowOrdinal: 0,
      jsonPointer: '/p|0|/x',
      span: { start: 0, end: 1 },
    };
    const secondLocation = {
      kind: 'native' as const,
      fileId: 'a|0|/p',
      rowOrdinal: 0,
      jsonPointer: '/x',
      span: { start: 0, end: 1 },
    };

    expect(replayFindingId(firstLocation, 'rule')).not.toBe(
      replayFindingId(secondLocation, 'rule'),
    );
    expect(
      replayOpaqueItemId('a', 0, '/p|0|/x', 'image'),
    ).not.toBe(
      replayOpaqueItemId('a|0|/p', 0, '/x', 'image'),
    );
  });

  it('keeps the exact schema-valid delimiter-collision coordinates independent', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files = [
      {
        id: 'a',
        role: 'primary',
        logicalPath: 'native/first.jsonl',
        rows: [
          {
            ordinal: 0,
            value: {
              'p|0|': { x: PREFIX_CANARY },
            },
          },
        ],
      },
      {
        id: 'a|0|/p',
        role: 'auxiliary',
        logicalPath: 'native/second.jsonl',
        rows: [
          {
            ordinal: 0,
            value: {
              x: `padding padding padding ${ALLOWED_CANARY}`,
            },
          },
        ],
      },
    ];
    const activeRuleset = mixedRuleset();
    const scan = scanReplayDraft(draft, activeRuleset, {
      generatedAt: AT,
    });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(
      scan.report.findings.map((finding) => finding.location),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'native',
          fileId: 'a',
          rowOrdinal: 0,
          jsonPointer: '/p|0|/x',
        }),
        expect.objectContaining({
          kind: 'native',
          fileId: 'a|0|/p',
          rowOrdinal: 0,
          jsonPointer: '/x',
        }),
      ]),
    );
    const report = structuredClone(scan.report);
    report.findings = report.findings.map((finding) => ({
      ...finding,
      disposition:
        finding.ruleId === 'prefix-canary'
          ? ('replace' as const)
          : ('allow' as const),
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
});
