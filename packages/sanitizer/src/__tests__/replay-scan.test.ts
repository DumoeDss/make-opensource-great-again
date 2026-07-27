import { describe, expect, it } from 'vitest';

import type { CompiledRuleset } from '../schemas.js';
import {
  resolveReplayLocationText,
  resolveReplayLocationSpan,
  scanReplayDraft,
} from '../replayScan.js';
import { makeReplayDraft } from './replay-fixtures.js';

const AT = '2026-07-27T00:00:00.000Z';

function ruleset(customPattern?: string): CompiledRuleset {
  return {
    rulesetVersion: 'replay-rules-v1',
    gitleaksVersion: 'fake',
    generatedAt: AT,
    rules: [],
    customRules: customPattern
      ? [
          {
            id: 'fake-canary',
            kind: 'literal',
            pattern: customPattern,
            replacement: '<REDACTED>',
          },
        ]
      : [],
    degraded: [],
  };
}

function secretRuleset(): CompiledRuleset {
  return {
    ...ruleset(),
    rulesetVersion: 'replay-secret-rules-v1',
    rules: [
      {
        id: 'fake-secret',
        description: 'obviously fake test canary',
        regexSource: 'FAKE_SECRET_[A-Z0-9]{12}',
        flags: '',
        keywords: ['FAKE_SECRET_'],
        translation: { status: 'native', notes: '' },
      },
    ],
  };
}

describe('scanReplayDraft', () => {
  it('finds nested and JSON-encoded native strings at exact stable locations', () => {
    const draft = makeReplayDraft();
    const first = scanReplayDraft(draft, ruleset('JSON_ENCODED_CANARY'), {
      generatedAt: AT,
    });
    const second = scanReplayDraft(draft, ruleset('JSON_ENCODED_CANARY'), {
      generatedAt: AT,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const finding = first.report.findings.find(
      (candidate) => candidate.ruleId === 'fake-canary',
    );
    expect(finding?.location).toMatchObject({
      kind: 'native',
      fileId: 'transcript',
      rowOrdinal: 7,
      jsonPointer: '/a~1b~0c/content/1/encoded',
    });
    expect(finding).toBeDefined();
    expect(resolveReplayLocationSpan(draft, finding!.location)).toBe(
      'JSON_ENCODED_CANARY',
    );
    expect(first.report.findings.map((item) => item.id)).toEqual(
      second.report.findings.map((item) => item.id),
    );
  });

  it('shares one pseudonym mapper across native, instruction, and metadata', () => {
    const draft = makeReplayDraft();
    const sharedPath = '/Users/fake/repository';
    draft.nativeSession.files[0]!.rows[0]!.value = {
      path: sharedPath,
    };
    draft.instructionSnapshot.files[0]!.content = `Use ${sharedPath}`;
    draft.omissions[0]!.disclosure = `Excluded ${sharedPath}`;

    const result = scanReplayDraft(draft, ruleset(), { generatedAt: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pathFindings = result.report.findings.filter(
      (finding) => finding.category === 'path',
    );
    expect(pathFindings).toHaveLength(3);
    expect(
      new Set(
        pathFindings.map((finding) => finding.replacementSuggestion),
      ),
    ).toEqual(new Set(['<PATH_1>']));
    expect(pathFindings.map((finding) => finding.location.kind).sort()).toEqual([
      'instruction',
      'metadata',
      'native',
    ]);
  });

  it('returns a strict stable error for invalid drafts', () => {
    const draft = { ...makeReplayDraft(), schemaVersion: '2.0.0' };
    const result = scanReplayDraft(
      draft as ReturnType<typeof makeReplayDraft>,
      ruleset(),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        schemaVersion: '1.0.0',
        code: 'invalid-draft',
        message: 'The ReplayBundle draft is invalid.',
      },
    });
  });

  it('rejects ambiguous native and instruction coordinates before scanning', () => {
    const duplicateFileIds = makeReplayDraft();
    duplicateFileIds.nativeSession.files.push({
      id: 'transcript',
      role: 'auxiliary',
      logicalPath: 'native/second-session.jsonl',
      rows: [{ ordinal: 0, value: { secret: 'SECOND_FILE_CANARY' } }],
    });
    expect(scanReplayDraft(duplicateFileIds, ruleset())).toMatchObject({
      ok: false,
      error: { code: 'invalid-draft' },
    });
    expect(
      resolveReplayLocationText(duplicateFileIds, {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 0,
        jsonPointer: '/secret',
        span: { start: 0, end: 18 },
      }),
    ).toBeUndefined();

    const duplicateRowOrdinals = makeReplayDraft();
    duplicateRowOrdinals.nativeSession.files[0]!.rows.push({
      ordinal: 7,
      value: { secret: 'DUPLICATE_ROW_CANARY' },
    });
    expect(scanReplayDraft(duplicateRowOrdinals, ruleset())).toMatchObject({
      ok: false,
      error: { code: 'invalid-draft' },
    });

    const duplicateInstructionIds = makeReplayDraft();
    duplicateInstructionIds.instructionSnapshot.files.push({
      id: 'instruction-1',
      kind: 'claude-md',
      stagePath: 'workspace/nested/CLAUDE.md',
      effectiveOrder: 1,
      content: 'SECOND_INSTRUCTION_CANARY',
    });
    expect(scanReplayDraft(duplicateInstructionIds, ruleset())).toMatchObject({
      ok: false,
      error: { code: 'invalid-draft' },
    });
  });

  it('surfaces Claude and Codex opaque blocks as pending gate items', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows = [
      {
        ordinal: 0,
        value: {
          type: 'user',
          message: {
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'obviously-fake-image-data',
                },
              },
            ],
          },
        },
      },
      {
        ordinal: 1,
        value: {
          type: 'response_item',
          payload: {
            type: 'message',
            content: [
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,obviously-fake',
              },
            ],
          },
        },
      },
    ];

    const result = scanReplayDraft(draft, ruleset(), { generatedAt: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.opaqueItems).toEqual([
      {
        id: expect.any(String),
        location: {
          kind: 'native',
          fileId: 'transcript',
          rowOrdinal: 0,
          jsonPointer: '/message/content/0',
        },
        blockType: 'image',
        matchPreview: '[opaque:image]',
        disposition: 'pending',
        replacement: null,
      },
      {
        id: expect.any(String),
        location: {
          kind: 'native',
          fileId: 'transcript',
          rowOrdinal: 1,
          jsonPointer: '/payload/content/0',
        },
        blockType: 'input_image',
        matchPreview: '[opaque:input_image]',
        disposition: 'pending',
        replacement: null,
      },
    ]);
    expect(result.report.gate).toMatchObject({
      opaquePending: 2,
      unlocked: false,
    });
    expect(
      draft.nativeSession.files[0]!.rows[0]!.value,
    ).toHaveProperty('message.content.0.source.data', 'obviously-fake-image-data');
  });

  it('covers unknown nested, JSON-encoded, and instruction secret leaves', () => {
    const draft = makeReplayDraft();
    const canary = 'FAKE_SECRET_ABCDEF123456';
    draft.nativeSession.files[0]!.rows[0]!.value = {
      future: {
        nested: canary,
        encodedArguments: JSON.stringify({ token: canary }),
      },
    };
    draft.instructionSnapshot.files[0]!.content = `Never print ${canary}.`;

    const first = scanReplayDraft(draft, secretRuleset(), {
      generatedAt: AT,
    });
    const second = scanReplayDraft(draft, secretRuleset(), {
      generatedAt: AT,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const hits = first.report.findings.filter(
      (finding) => finding.ruleId === 'fake-secret',
    );
    expect(hits).toHaveLength(3);
    expect(
      hits.map((finding) =>
        finding.location.kind === 'native'
          ? finding.location.jsonPointer
          : finding.location.kind,
      ),
    ).toEqual([
      '/future/encodedArguments',
      '/future/nested',
      'instruction',
    ]);
    expect(
      hits.every(
        (finding) =>
          resolveReplayLocationSpan(draft, finding.location) === canary,
      ),
    ).toBe(true);
    expect(hits.every((finding) => !finding.matchPreview.includes(canary))).toBe(
      true,
    );
    expect(hits.map((finding) => finding.id)).toEqual(
      second.report.findings
        .filter((finding) => finding.ruleId === 'fake-secret')
        .map((finding) => finding.id),
    );
    expect(first.report.gate.unlocked).toBe(false);
  });

  it('turns oversize string tails into a blocking guard finding', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      futureOversize: 'x'.repeat(200_001),
    };
    const result = scanReplayDraft(draft, ruleset(), { generatedAt: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const guard = result.report.findings.find(
      (finding) => finding.ruleId === 'redos-guard',
    );
    expect(guard).toMatchObject({
      layer: 'guard',
      blocking: true,
      disposition: 'pending',
      location: {
        kind: 'native',
        jsonPointer: '/futureOversize',
      },
    });
    expect(result.report.gate.unlocked).toBe(false);
  });
});
