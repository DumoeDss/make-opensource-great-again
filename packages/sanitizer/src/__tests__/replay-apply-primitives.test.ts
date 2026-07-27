import type {
  ReplayBundleDraft,
  ReplayFinding,
  ReplayFindingLocation,
} from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyReplayFindingEdits,
  hashReplayMatch,
} from '../replayApply.js';
import {
  replayFindingId,
  resolveReplayLocationText,
} from '../replayScan.js';
import { makeReplayDraft } from './replay-fixtures.js';

function finding(
  draft: ReplayBundleDraft,
  location: ReplayFindingLocation,
  disposition: ReplayFinding['disposition'],
  replacementSuggestion = '<REPLACED>',
  ruleId = 'fake-rule',
): ReplayFinding {
  const text = resolveReplayLocationText(draft, location);
  if (text === undefined) throw new Error('fixture location is not a string');
  return {
    id: replayFindingId(location, ruleId),
    layer: 'custom',
    ruleId,
    category: null,
    location,
    matchPreview: 'r…d',
    matchHash: hashReplayMatch(
      text.slice(location.span.start, location.span.end),
    ),
    replacementSuggestion,
    disposition,
    blocking: true,
  };
}

describe('replay apply primitives', () => {
  it('immutably edits exact native, instruction, and metadata spans', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = {
      secret: 'prefix NATIVE suffix',
      reference: 'keep-reference',
      count: 7,
    };
    draft.instructionSnapshot.files[0]!.content =
      'prefix INSTRUCTION suffix';
    draft.omissions[0]!.disclosure = 'prefix METADATA suffix';
    const before = structuredClone(draft);

    const findings = [
      finding(
        draft,
        {
          kind: 'native',
          fileId: 'transcript',
          rowOrdinal: 7,
          jsonPointer: '/secret',
          span: { start: 7, end: 13 },
        },
        'replace',
      ),
      finding(
        draft,
        {
          kind: 'instruction',
          instructionId: 'instruction-1',
          span: { start: 7, end: 18 },
        },
        'delete',
      ),
      finding(
        draft,
        {
          kind: 'metadata',
          fieldPath: '/omissions/0/disclosure',
          span: { start: 7, end: 15 },
        },
        'replace',
        '<META>',
      ),
    ];
    const result = applyReplayFindingEdits(draft, findings);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      result.draft.nativeSession.files[0]!.rows[0]!.value,
    ).toEqual({
      secret: 'prefix <REPLACED> suffix',
      reference: 'keep-reference',
      count: 7,
    });
    expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
      'prefix  suffix',
    );
    expect(result.draft.omissions[0]!.disclosure).toBe(
      'prefix <META> suffix',
    );
    expect(draft).toEqual(before);
  });

  it('uses outer-span-wins and descending offsets', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = '0123456789';
    const outer = finding(
      draft,
      {
        kind: 'instruction',
        instructionId: 'instruction-1',
        span: { start: 2, end: 8 },
      },
      'replace',
      '<OUTER>',
      'outer',
    );
    const inner = finding(
      draft,
      {
        kind: 'instruction',
        instructionId: 'instruction-1',
        span: { start: 4, end: 6 },
      },
      'replace',
      '<INNER>',
      'inner',
    );
    const tail = finding(
      draft,
      {
        kind: 'instruction',
        instructionId: 'instruction-1',
        span: { start: 8, end: 10 },
      },
      'delete',
      '',
      'tail',
    );
    const result = applyReplayFindingEdits(draft, [inner, tail, outer]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.instructionSnapshot.files[0]!.content).toBe(
        '01<OUTER>',
      );
    }
  });

  it.each([
    ['missing-location', '/missing', { start: 0, end: 1 }],
    ['out-of-range-location', '/secret', { start: 0, end: 99 }],
  ])('returns %s without a partial output', (code, jsonPointer, span) => {
    const draft = makeReplayDraft();
    draft.nativeSession.files[0]!.rows[0]!.value = { secret: 'value' };
    const location: ReplayFindingLocation = {
      kind: 'native',
      fileId: 'transcript',
      rowOrdinal: 7,
      jsonPointer,
      span,
    };
    const item: ReplayFinding = {
      id: replayFindingId(location, 'rule'),
      layer: 'custom',
      ruleId: 'rule',
      category: null,
      location,
      matchPreview: 'x',
      matchHash: hashReplayMatch('value'),
      replacementSuggestion: '<X>',
      disposition: 'replace',
      blocking: true,
    };
    expect(applyReplayFindingEdits(draft, [item])).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it('rejects a stale match hash without changing the input', () => {
    const draft = makeReplayDraft();
    draft.instructionSnapshot.files[0]!.content = 'reviewed';
    const location: ReplayFindingLocation = {
      kind: 'instruction',
      instructionId: 'instruction-1',
      span: { start: 0, end: 8 },
    };
    const item = finding(draft, location, 'replace');
    item.matchHash = hashReplayMatch('different');
    const before = structuredClone(draft);
    expect(applyReplayFindingEdits(draft, [item])).toMatchObject({
      ok: false,
      error: { code: 'stale-location' },
    });
    expect(draft).toEqual(before);
  });

  it('preserves native file/row order, unknown fields, scalars, and references', () => {
    const draft = makeReplayDraft();
    draft.nativeSession.files = [
      {
        id: 'transcript',
        role: 'primary',
        logicalPath: 'native/session.jsonl',
        rows: [
          {
            ordinal: 0,
            value: {
              type: 'session_meta',
              payload: { id: 'session-ref', enabled: true, count: 3 },
            },
          },
          {
            ordinal: 1,
            value: {
              type: 'turn_context',
              payload: {
                model: 'gpt-fake',
                privateNote: 'prefix SENSITIVE suffix',
              },
            },
          },
          {
            ordinal: 2,
            value: {
              type: 'response_item',
              payload: {
                type: 'function_call',
                call_id: 'tool-ref',
                arguments: '{"path":"fake.txt"}',
              },
            },
          },
          {
            ordinal: 3,
            value: {
              type: 'event_msg',
              payload: { call_id: 'tool-ref', mirror: true },
            },
          },
        ],
      },
      {
        id: 'future-file',
        role: 'auxiliary',
        logicalPath: 'native/future.jsonl',
        rows: [
          {
            ordinal: 0,
            value: {
              type: 'future-row',
              reference: 'session-ref',
              unknown: [null, 4, false],
            },
          },
        ],
      },
    ];
    const before = structuredClone(draft);
    const location: ReplayFindingLocation = {
      kind: 'native',
      fileId: 'transcript',
      rowOrdinal: 1,
      jsonPointer: '/payload/privateNote',
      span: { start: 7, end: 16 },
    };
    const result = applyReplayFindingEdits(draft, [
      finding(draft, location, 'replace', '<SAFE>'),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = structuredClone(before);
    (
      expected.nativeSession.files[0]!.rows[1]!.value as {
        payload: { privateNote: string };
      }
    ).payload.privateNote = 'prefix <SAFE> suffix';
    expect(result.draft.nativeSession).toEqual(expected.nativeSession);
    expect(
      result.draft.nativeSession.files.map((file) => file.id),
    ).toEqual(['transcript', 'future-file']);
    expect(
      result.draft.nativeSession.files[0]!.rows.map((row) => row.ordinal),
    ).toEqual([0, 1, 2, 3]);
    expect(draft).toEqual(before);
  });
});
