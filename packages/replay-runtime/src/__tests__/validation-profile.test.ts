import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import { CODEX_PROFILE } from '../adapters/codex.js';
import {
  parseProbeEvidence,
  resolveTrustedBinary,
} from '../adapters/capabilityProbe.js';
import {
  runtimeAdapterFor,
  selectCapabilityProfile,
} from '../adapters/registry.js';
import { normalizeRuntimeOptions } from '../config.js';
import { validateAndBrandReplayBundle } from '../validated.js';
import { createReplayRuntimeInternal } from '../runtime.js';
import { sealedBundle } from './fixtures.js';

function evidenceFor(
  profile: typeof CLAUDE_CODE_PROFILE | typeof CODEX_PROFILE,
  version: string,
) {
  return {
    sourceCli: profile.sourceCli,
    version,
    normalizedMarkers: new Set(profile.requiredMarkers),
  } as const;
}

describe('validation-first runtime boundary', () => {
  it('rejects every integrity mutation before any process or workspace side effect', async () => {
    const bundle = sealedBundle();
    bundle.payload.nativeSession.files[0]!.rows[0]!.value = {
      mutated: true,
    };
    const sideEffect = vi.fn();
    const runtime = createReplayRuntimeInternal(
      {},
      {
        resolveBinary: sideEffect,
        captureExecutable: sideEffect,
        probe: sideEffect,
        createWorkspace: sideEffect,
        exposeSkills: sideEffect,
        supervise: sideEffect,
        cleanup: sideEffect,
        staleCleanup: sideEffect,
      },
    );

    const result = await runtime.prepare({ bundle });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'bundle-invalid',
        stage: 'validate',
        sourceCli: null,
        replayCliVersion: null,
        cleanup: 'not-created',
      },
    });
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('rejects caller-asserted payloads and unsafe fixed aliases', () => {
    const bundle = sealedBundle();
    expect(() =>
      validateAndBrandReplayBundle(bundle.payload),
    ).toThrowError(expect.objectContaining({ code: 'bundle-invalid' }));

    const unsafe = sealedBundle();
    unsafe.payload.runtimePolicy.workingDirectoryAlias = '../outside';
    expect(() => validateAndBrandReplayBundle(unsafe)).toThrowError(
      expect.objectContaining({ code: 'bundle-invalid' }),
    );
  });

  it('strictly validates trusted process options and skill descriptors', async () => {
    expect(() =>
      normalizeRuntimeOptions({
        binaryOverrides: { codex: 'relative-codex' },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'runtime-policy-unsupported' }),
    );
    expect(() =>
      normalizeRuntimeOptions({
        limits: { terminalInputBytes: 0 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'runtime-policy-unsupported' }),
    );

    const runtime = createReplayRuntimeInternal(
      {},
      {
        resolveBinary: vi.fn(),
        captureExecutable: vi.fn(),
        probe: vi.fn(),
        createWorkspace: vi.fn(),
        exposeSkills: vi.fn(),
        supervise: vi.fn(),
        cleanup: vi.fn(),
        staleCleanup: vi.fn(),
      },
    );
    const result = await runtime.prepare({
      bundle: sealedBundle(),
      skillRoots: [
        {
          id: '../bad',
          sourcePath: path.resolve('skills'),
          scope: 'user',
          precedence: 0,
        },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'skill-root-invalid', cleanup: 'not-created' },
    });
  });
});

describe('closed capability profile matrix', () => {
  it('selects only complete matching Claude and Codex evidence', () => {
    const claude = validateAndBrandReplayBundle(sealedBundle());
    expect(
      selectCapabilityProfile(
        runtimeAdapterFor('claude-code'),
        claude,
        evidenceFor(CLAUDE_CODE_PROFILE, '2.1.42'),
      ).id,
    ).toBe(CLAUDE_CODE_PROFILE.id);

    const codex = validateAndBrandReplayBundle(sealedBundle('codex'));
    expect(
      selectCapabilityProfile(
        runtimeAdapterFor('codex'),
        codex,
        evidenceFor(CODEX_PROFILE, '0.101.9'),
      ).id,
    ).toBe(CODEX_PROFILE.id);
  });

  it.each([
    ...CLAUDE_CODE_PROFILE.requiredMarkers.map(
      (marker) => [CLAUDE_CODE_PROFILE, marker] as const,
    ),
    ...CODEX_PROFILE.requiredMarkers.map(
      (marker) => [CODEX_PROFILE, marker] as const,
    ),
  ])(
    'rejects the individual %s profile near miss for marker %s',
    (profile, missingMarker) => {
      const validated = validateAndBrandReplayBundle(
        sealedBundle(profile.sourceCli),
      );
      expect(() =>
        selectCapabilityProfile(
          runtimeAdapterFor(profile.sourceCli),
          validated,
          {
            sourceCli: profile.sourceCli,
            version:
              profile.sourceCli === 'claude-code'
                ? '2.1.9'
                : '0.101.8',
            normalizedMarkers: new Set(
              profile.requiredMarkers.filter(
                (marker) => marker !== missingMarker,
              ),
            ),
          },
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'cli-capability-unsupported',
        }),
      );
    },
  );

  it('rejects version-only, unknown newer, wrong-format, and ambiguous evidence', () => {
    const claude = validateAndBrandReplayBundle(sealedBundle());
    expect(() =>
      selectCapabilityProfile(
        runtimeAdapterFor('claude-code'),
        claude,
        {
          sourceCli: 'claude-code',
          version: '2.1.1',
          normalizedMarkers: new Set(['--resume']),
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-capability-unsupported' }),
    );
    expect(() =>
      selectCapabilityProfile(
        runtimeAdapterFor('claude-code'),
        claude,
        evidenceFor(CLAUDE_CODE_PROFILE, '2.2.0'),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-version-unsupported' }),
    );

    const ambiguousAdapter = {
      sourceCli: 'claude-code' as const,
      profiles: [CLAUDE_CODE_PROFILE, CLAUDE_CODE_PROFILE],
    };
    expect(() =>
      selectCapabilityProfile(
        ambiguousAdapter,
        claude,
        evidenceFor(CLAUDE_CODE_PROFILE, '2.1.1'),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-capability-unsupported' }),
    );
  });

  it('parses only bounded normalized evidence and rejects malformed versions', () => {
    const adapter = runtimeAdapterFor('claude-code');
    const parsed = parseProbeEvidence(adapter, [
      'Claude Code 2.1.5',
      [
        'Usage: claude [options]',
        '--print',
        '--resume <session-id>',
        '--dangerously-skip-permissions',
        'stdin prompt supported',
        'isolated-home supported',
        'ANTHROPIC_BASE_URL route override',
      ].join('\n'),
    ]);
    expect(parsed.version).toBe('2.1.5');
    expect(parsed.normalizedMarkers).toEqual(
      new Set(CLAUDE_CODE_PROFILE.requiredMarkers),
    );
    expect(parsed).not.toHaveProperty('rawOutput');
    expect(() => parseProbeEvidence(adapter, ['not a version'])).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
  });

  it('classifies an absent absolute override without trying another command', async () => {
    const config = normalizeRuntimeOptions({
      binaryOverrides: {
        'claude-code': path.resolve('definitely-absent-claude.exe'),
      },
    });
    await expect(
      resolveTrustedBinary('claude-code', config),
    ).rejects.toMatchObject({ code: 'cli-not-found' });
  });
});
