import { describe, expect, it } from 'vitest';

import {
  collectJsonStringLeaves,
  collectReplayScanUnits,
  resolveJsonPointer,
  resolveReplayLocationSpan,
  resolveReplayLocationText,
} from '../replayScan.js';
import { makeReplayDraft } from './replay-fixtures.js';

describe('ReplayBundle recursive scan traversal', () => {
  it('visits every native string leaf with escaped RFC 6901 pointers', () => {
    const draft = makeReplayDraft();
    const native = collectReplayScanUnits(draft).filter((unit) => {
      const location = unit.location({ start: 0, end: unit.text.length });
      return location.kind === 'native';
    });
    const locations = native.map((unit) =>
      unit.location({ start: 0, end: unit.text.length }),
    );
    expect(locations).toEqual([
      {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 7,
        jsonPointer: '/a~1b~0c/content/0/text',
        span: { start: 0, end: 10 },
      },
      {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 7,
        jsonPointer: '/a~1b~0c/content/1/encoded',
        span: { start: 0, end: 32 },
      },
      {
        kind: 'native',
        fileId: 'transcript',
        rowOrdinal: 7,
        jsonPointer: '/type',
        span: { start: 0, end: 6 },
      },
    ]);
  });

  it('collects instruction content and fixed metadata without scalar coercion', () => {
    const draft = makeReplayDraft();
    const units = collectReplayScanUnits(draft);
    const locations = units.map((unit) =>
      unit.location({ start: 0, end: unit.text.length }),
    );
    expect(
      locations.some(
        (location) =>
          location.kind === 'instruction' &&
          location.instructionId === 'instruction-1',
      ),
    ).toBe(true);
    expect(
      locations.some(
        (location) =>
          location.kind === 'metadata' &&
          location.fieldPath === '/delivery/targetModel',
      ),
    ).toBe(true);
    expect(units.some((unit) => unit.text === 'Repository identity was not retained.')).toBe(
      true,
    );
    expect(units.some((unit) => unit.text === '200000')).toBe(false);
    expect(units.some((unit) => unit.text === 'true')).toBe(false);
  });

  it('round-trips native, instruction, and metadata locations exactly', () => {
    const draft = makeReplayDraft();
    const units = collectReplayScanUnits(draft);
    for (const unit of units) {
      const start = unit.text.length > 2 ? 1 : 0;
      const end = Math.min(unit.text.length, start + 4);
      const location = unit.location({ start, end });
      expect(resolveReplayLocationText(draft, location)).toBe(unit.text);
      expect(resolveReplayLocationSpan(draft, location)).toBe(
        unit.text.slice(start, end),
      );
    }
  });

  it('resolves pointer escapes and rejects malformed or missing pointers', () => {
    const draft = makeReplayDraft();
    const row = draft.nativeSession.files[0]!.rows[0]!.value;
    expect(resolveJsonPointer(row, '/a~1b~0c/content/0/text')).toBe('first leaf');
    expect(resolveJsonPointer(row, '/a~2b')).toBeUndefined();
    expect(resolveJsonPointer(row, '/missing')).toBeUndefined();
    expect(collectJsonStringLeaves(row)).toHaveLength(3);
  });
});
