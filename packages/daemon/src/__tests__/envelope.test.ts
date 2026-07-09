/**
 * buildEnvelope provenance unit tests. The envelope's `meta.sourceCli` MUST
 * reflect the originating adapter (its source id is exactly a SOURCE_CLI value),
 * not a hardcoded literal — a codex session labelled `claude-code` would
 * mis-provenance the review/publish record.
 */
import type { CliSessionRef } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import { buildEnvelope } from '../envelope.js';

function makeRef(sourceId: string): CliSessionRef {
  return {
    sourceId,
    projectKey: 'proj',
    id: 'sess-1',
    path: '/tmp/sess-1.jsonl',
    title: 't',
    cwd: '/tmp/proj',
    updatedAt: 123,
    sizeBytes: 10,
  };
}

describe('buildEnvelope — sourceCli provenance', () => {
  it('derives sourceCli from a codex ref', () => {
    const env = buildEnvelope(makeRef('codex'), []);
    expect(env.meta.sourceCli).toBe('codex');
  });

  it('keeps claude-code provenance for a claude-code ref', () => {
    const env = buildEnvelope(makeRef('claude-code'), []);
    expect(env.meta.sourceCli).toBe('claude-code');
  });

  it('fails closed on an unknown source id rather than mislabeling', () => {
    expect(() => buildEnvelope(makeRef('bogus'), [])).toThrow();
  });
});
