import { describe, expect, it } from 'vitest';

import {
  canonicalizeReplayJson,
  serializeInstructionFile,
  serializeNativeJsonl,
} from '../canonical.js';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('mosga-replay-canonical-json-v1', () => {
  it('sorts object keys by code point, preserves arrays, and emits no whitespace', () => {
    const value = {
      z: 1,
      '\u{10000}': 2,
      '\uE000': 3,
      a: [{ second: true, first: null }, 'tail'],
    };

    expect(text(canonicalizeReplayJson(value))).toBe(
      '{"a":[{"first":null,"second":true},"tail"],"z":1,"":3,"𐀀":2}',
    );
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    new Date(0),
    () => undefined,
    { invalid: undefined },
    [undefined],
    // eslint-disable-next-line no-sparse-arrays
    [, 'sparse'],
  ])('rejects non-JSON input %#', (value) => {
    expect(() => canonicalizeReplayJson(value)).toThrow(
      /only finite, acyclic JSON values/,
    );
  });

  it('rejects cycles', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeReplayJson(cyclic)).toThrow(/acyclic/);
  });
});

describe('canonical replay content entries', () => {
  it('serializes native rows in source order with one canonical object and LF per row', () => {
    const bytes = serializeNativeJsonl({
      id: 'transcript',
      role: 'primary',
      logicalPath: 'native/session.jsonl',
      rows: [
        { ordinal: 7, value: { z: 1, a: 'first' } },
        {
          ordinal: 2,
          value: { type: 'future', nested: [false, null, 4] },
        },
      ],
    });

    expect(text(bytes)).toBe(
      '{"a":"first","z":1}\n{"nested":[false,null,4],"type":"future"}\n',
    );
  });

  it('serializes LF-normalized instruction content with exactly one required terminal LF', () => {
    const base = {
      id: 'instruction-1',
      kind: 'claude-md' as const,
      stagePath: 'workspace/CLAUDE.md',
      effectiveOrder: 0,
    };
    expect(
      text(serializeInstructionFile({ ...base, content: 'one\ntwo' })),
    ).toBe('one\ntwo\n');
    expect(
      text(serializeInstructionFile({ ...base, content: 'one\ntwo\n' })),
    ).toBe('one\ntwo\n');
    expect(() =>
      serializeInstructionFile({ ...base, content: 'one\r\ntwo' }),
    ).toThrow(/LF-normalized/);
  });
});
