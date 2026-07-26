import type { InstructionCandidate } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import { buildInstructionSnapshot } from '../draft.js';

describe('instruction candidate conversion', () => {
  it('normalizes UTF-8/LF, sorts deterministically, and elides source paths', () => {
    const candidates: InstructionCandidate[] = [
      {
        sourcePath: 'C:\\private\\project\\AGENTS.md',
        kind: 'agents-md',
        stagePath: 'workspace/project-1/AGENTS.md',
        effectiveOrder: 1,
        content: new TextEncoder().encode('inner\r\nrules\rtail'),
      },
      {
        sourcePath: '/private/home/CLAUDE.md',
        kind: 'claude-md',
        stagePath: 'workspace/CLAUDE.md',
        effectiveOrder: 0,
        content: 'outer\r\nrules',
      },
    ];

    const first = buildInstructionSnapshot(candidates);
    const second = buildInstructionSnapshot([...candidates].reverse());

    expect(first).toEqual(second);
    expect(first.files.map((file) => file.stagePath)).toEqual([
      'workspace/CLAUDE.md',
      'workspace/project-1/AGENTS.md',
    ]);
    expect(first.files.map((file) => file.content)).toEqual([
      'outer\nrules',
      'inner\nrules\ntail',
    ]);
    const stored = JSON.stringify(first);
    expect(stored).not.toContain('private');
    expect(stored).not.toContain('sourcePath');
  });

  it('rejects duplicate aliased stage paths', () => {
    const candidate: InstructionCandidate = {
      sourcePath: '/private/a/CLAUDE.md',
      kind: 'claude-md',
      stagePath: 'workspace/CLAUDE.md',
      effectiveOrder: 0,
      content: 'one',
    };
    expect(() =>
      buildInstructionSnapshot([
        candidate,
        { ...candidate, sourcePath: '/private/b/CLAUDE.md', content: 'two' },
      ]),
    ).toThrow(/unique/);
  });

  it.each([
    '/absolute/CLAUDE.md',
    'C:/private/CLAUDE.md',
    '\\\\server\\share\\CLAUDE.md',
    '../CLAUDE.md',
    './CLAUDE.md',
    'workspace//CLAUDE.md',
    'workspace/./CLAUDE.md',
    'workspace/../CLAUDE.md',
    'workspace\\CLAUDE.md',
    'workspace/CLAUDE.md\0hidden',
    'workspace/not-CLAUDE.md',
  ])('rejects unsafe stage path %s', (stagePath) => {
    expect(() =>
      buildInstructionSnapshot([
        {
          sourcePath: '/private/CLAUDE.md',
          kind: 'claude-md',
          stagePath,
          effectiveOrder: 0,
          content: 'safe',
        },
      ]),
    ).toThrow(/safe relative POSIX path/);
  });

  it('rejects a kind/basename mismatch', () => {
    expect(() =>
      buildInstructionSnapshot([
        {
          sourcePath: '/private/AGENTS.md',
          kind: 'agents-md',
          stagePath: 'workspace/CLAUDE.md',
          effectiveOrder: 0,
          content: 'safe',
        },
      ]),
    ).toThrow(/matching recognized basename/);
  });

  it('rejects malformed UTF-8 bytes', () => {
    expect(() =>
      buildInstructionSnapshot([
        {
          sourcePath: '/private/CLAUDE.md',
          kind: 'claude-md',
          stagePath: 'workspace/CLAUDE.md',
          effectiveOrder: 0,
          content: new Uint8Array([0xc3, 0x28]),
        },
      ]),
    ).toThrow(/valid UTF-8/);
  });
});
