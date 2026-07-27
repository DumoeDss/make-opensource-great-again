import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import { CODEX_PROFILE } from '../adapters/codex.js';
import { RuntimeFault } from '../errors.js';
import type { RuntimeDependencies } from '../runtime.js';
import { createReplayRuntimeInternal } from '../runtime.js';
import { sealedBundle } from './fixtures.js';

function fakeWorkspace() {
  const root = path.resolve('fake-replay-root');
  return {
    rootId: 'fake-root',
    inventory: [],
    paths: {
      root,
      cliHome: path.join(root, 'cli-home'),
      workspace: path.join(root, 'workspace'),
      workingDirectory: path.join(root, 'workspace', 'project-1'),
      runtime: path.join(root, 'runtime'),
      cache: path.join(root, 'cache'),
      temporary: path.join(root, 'tmp'),
    },
  };
}

function fakeDependencies(
  source: 'claude-code' | 'codex' = 'claude-code',
): RuntimeDependencies & {
  processCalls: ReturnType<typeof vi.fn>;
  cleanupCalls: ReturnType<typeof vi.fn>;
} {
  const profile =
    source === 'claude-code' ? CLAUDE_CODE_PROFILE : CODEX_PROFILE;
  const processCalls = vi.fn(async () => ({
    startedAtMs: 1_000,
    completedAtMs: 1_025,
    exitStatus: 0 as const,
  }));
  const cleanupCalls = vi.fn(async () => {});
  const executableIdentity = Object.freeze({
    path: path.resolve('fake-cli.exe'),
    device: '1',
    inode: '1',
    size: '1',
    modifiedNanoseconds: '1',
    changedNanoseconds: '1',
    digest: `sha256:${'a'.repeat(64)}` as const,
  });
  return {
    resolveBinary: vi.fn(async () => path.resolve('fake-cli.exe')),
    captureExecutable: vi.fn(async () => executableIdentity),
    stageOwnedExecutable: vi.fn(async (originalPath: string, _dir: string, probedIdentity: typeof executableIdentity) =>
      Object.freeze({
        runtimePath: originalPath,
        identity: probedIdentity,
      }),
    ),
    probe: vi.fn(async () => ({
      sourceCli: source,
      version: source === 'claude-code' ? '2.1.9' : '0.101.8',
      normalizedMarkers: new Set(profile.requiredMarkers),
    })),
    createWorkspace: vi.fn(async () => fakeWorkspace()),
    exposeSkills: vi.fn(async () => {}),
    supervise: processCalls,
    cleanup: cleanupCalls,
    staleCleanup: vi.fn(async () => {}),
    processCalls,
    cleanupCalls,
  };
}

function matchingRoute(source: 'claude-code' | 'codex') {
  return {
    sourceCli: source,
    wireProtocol:
      source === 'claude-code'
        ? ('anthropic-messages' as const)
        : ('openai-responses' as const),
    transport: 'loopback-http' as const,
    authScheme: 'route-bearer' as const,
    targetProviderId: 'target-provider',
    targetModel: 'target-model',
    baseUrl: 'http://127.0.0.1:43123/v1',
    routeToken: 'opaque-route-token-canary',
    cliModel: 'target-cli-model',
  };
}

describe('prepared replay lifecycle', () => {
  it('returns a frozen null-prototype facade with no reachable launch authority and an atomic one-use latch', async () => {
    const dependencies = fakeDependencies();
    let releaseProcess!: () => void;
    const processGate = new Promise<void>((resolve) => {
      releaseProcess = resolve;
    });
    dependencies.processCalls.mockImplementationOnce(async () => {
      await processGate;
      return {
        startedAtMs: 1_000,
        completedAtMs: 1_025,
        exitStatus: 0 as const,
      };
    });
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const preparedResult = await runtime.prepare({
      bundle: sealedBundle(),
    });
    if (!preparedResult.ok) throw new Error('fixture did not prepare');
    const handle = preparedResult.prepared;

    expect(Object.keys(handle).sort()).toEqual([
      'dispose',
      'execute',
      'observation',
    ]);
    expect(Reflect.ownKeys(handle).sort()).toEqual([
      'dispose',
      'execute',
      'observation',
    ]);
    expect(Object.getPrototypeOf(handle)).toBeNull();
    expect(Object.getPrototypeOf(handle.execute)).toBeNull();
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.execute)).toBe(true);
    expect(Reflect.set(handle as object, 'state', 'prepared')).toBe(false);
    expect(
      Reflect.set(handle as object, 'executable', path.resolve('evil.exe')),
    ).toBe(false);
    expect(Reflect.setPrototypeOf(handle, { state: 'prepared' })).toBe(
      false,
    );
    expect(() =>
      Object.defineProperty(handle, 'workspace', {
        value: path.resolve('stolen-root'),
      }),
    ).toThrow(TypeError);
    const serialized = JSON.stringify(handle);
    expect(serialized).not.toMatch(
      /fake-replay-root|fake-cli|opaque-route-token-canary|reviewed instructions|hello/,
    );

    const first = handle.execute({
      terminalInput: 'terminal-opacity-canary',
      route: matchingRoute('claude-code'),
    });
    await vi.waitFor(() =>
      expect(dependencies.processCalls).toHaveBeenCalledTimes(1),
    );
    expect(Reflect.set(handle as object, 'state', 'prepared')).toBe(false);
    const second = handle.execute({
      terminalInput: 'terminal-opacity-canary',
      route: matchingRoute('claude-code'),
    });
    releaseProcess();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({
      ok: false,
      error: { code: 'prepared-replay-consumed' },
    });
    expect(dependencies.processCalls).toHaveBeenCalledTimes(1);
  });

  it('prepares an immutable safe observation and executes one stdin-only launch', async () => {
    const dependencies = fakeDependencies();
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const bundle = sealedBundle();
    const before = structuredClone(bundle);

    const preparedResult = await runtime.prepare({ bundle });
    expect(preparedResult.ok).toBe(true);
    if (!preparedResult.ok) return;
    expect(preparedResult.prepared.observation).toMatchObject({
      sourceCli: 'claude-code',
      recordedCliVersion: '1.2.3',
      replayCliVersion: '2.1.9',
      capabilityProfileId: CLAUDE_CODE_PROFILE.id,
      delivery: {
        targetProviderId: 'target-provider',
        targetModel: 'target-model',
      },
      routeRequirement: {
        wireProtocol: 'anthropic-messages',
      },
    });
    expect(preparedResult.prepared.observation.bundleContentHash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(Object.isFrozen(preparedResult.prepared.observation)).toBe(true);
    expect(bundle).toEqual(before);

    const terminalInput = 'terminal-input-独立-canary';
    const result = await preparedResult.prepared.execute({
      terminalInput,
      route: matchingRoute('claude-code'),
    });
    expect(result).toMatchObject({
      ok: true,
      startedAt: '1970-01-01T00:00:01.000Z',
      completedAt: '1970-01-01T00:00:01.025Z',
      durationMs: 25,
      exitStatus: 0,
    });
    expect(dependencies.processCalls).toHaveBeenCalledTimes(1);
    const [plan, stdin] = dependencies.processCalls.mock.calls[0]!;
    expect(new TextDecoder().decode(stdin)).toBe(terminalInput);
    expect(JSON.stringify(plan.argv)).not.toContain(terminalInput);
    expect(JSON.stringify(plan.environment)).not.toContain(terminalInput);
    expect(plan.argv).not.toContain('opaque-route-token-canary');
    expect(plan.environment.ANTHROPIC_AUTH_TOKEN).toBe(
      'opaque-route-token-canary',
    );
    expect(plan.environment).not.toHaveProperty('PATH');
    expect(dependencies.cleanupCalls).toHaveBeenCalledTimes(1);
    // captureExecutable runs twice in prepare (before + after probe). The
    // pre-spawn identity re-check now lives inside the supervisor (mocked here).
    expect(dependencies.captureExecutable).toHaveBeenCalledTimes(2);

    const second = await preparedResult.prepared.execute({
      terminalInput,
      route: matchingRoute('claude-code'),
    });
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: 'prepared-replay-consumed',
        cleanup: 'complete',
      },
    });
    expect(dependencies.processCalls).toHaveBeenCalledTimes(1);
    await preparedResult.prepared.dispose();
    await preparedResult.prepared.dispose();
    expect(dependencies.cleanupCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['https://127.0.0.1:1234', 'scheme'],
    ['http://example.com:1234', 'remote'],
    ['http://127.0.0.1/path', 'missing-port'],
    ['http://user@127.0.0.1:1234', 'userinfo'],
    ['http://127.0.0.1:1234/#frag', 'fragment'],
  ])('rejects an invalid route %s (%s) before launch', async (baseUrl) => {
    const dependencies = fakeDependencies();
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: 'terminal',
      route: { ...matchingRoute('claude-code'), baseUrl },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'route-binding-invalid', cleanup: 'complete' },
    });
    expect(dependencies.processCalls).not.toHaveBeenCalled();
  });

  it.each([
    [{ sourceCli: 'codex' }, 'source'],
    [{ wireProtocol: 'openai-responses' }, 'protocol'],
    [{ authScheme: 'wrong-auth' }, 'auth'],
    [{ transport: 'remote-http' }, 'transport'],
    [{ targetProviderId: 'other' }, 'provider'],
    [{ targetModel: 'other' }, 'model'],
    [{ routeToken: '' }, 'token'],
    [{ cliModel: '' }, 'cli-model'],
  ])('rejects a %s route mismatch before launch', async (patch) => {
    const dependencies = fakeDependencies();
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: 'terminal',
      route: { ...matchingRoute('claude-code'), ...patch } as never,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'route-binding-invalid' },
    });
    expect(dependencies.processCalls).not.toHaveBeenCalled();
  });

  it.each([
    ['routeToken', 'prefix-terminal-route-canary-suffix'],
    ['cliModel', 'model-terminal-route-canary-alias'],
  ])(
    'rejects terminal input duplicated through route %s',
    async (field, collision) => {
      const dependencies = fakeDependencies();
      const runtime = createReplayRuntimeInternal({}, dependencies);
      const prepared = await runtime.prepare({ bundle: sealedBundle() });
      if (!prepared.ok) throw new Error('fixture did not prepare');
      const result = await prepared.prepared.execute({
        terminalInput: 'terminal-route-canary',
        route: {
          ...matchingRoute('claude-code'),
          [field]: collision,
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'route-binding-invalid',
          cleanup: 'complete',
        },
      });
      expect(dependencies.processCalls).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'nul\0value', '\ud800'])(
    'rejects invalid terminal input before launch',
    async (terminalInput) => {
      const dependencies = fakeDependencies();
      const runtime = createReplayRuntimeInternal({}, dependencies);
      const prepared = await runtime.prepare({ bundle: sealedBundle() });
      if (!prepared.ok) throw new Error('fixture did not prepare');
      const result = await prepared.prepared.execute({
        terminalInput,
        route: matchingRoute('claude-code'),
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'terminal-input-invalid' },
      });
      expect(dependencies.processCalls).not.toHaveBeenCalled();
    },
  );

  it('pre-abort consumes and cleans without launching', async () => {
    const dependencies = fakeDependencies();
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const abort = new AbortController();
    abort.abort();
    const result = await prepared.prepared.execute({
      terminalInput: 'terminal',
      route: matchingRoute('claude-code'),
      signal: abort.signal,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cancelled', cleanup: 'complete' },
    });
    expect(dependencies.processCalls).not.toHaveBeenCalled();
  });

  it('rejects arbitrary credential environment input and excludes parent secrets', async () => {
    const previous = process.env.PROVIDER_SECRET_CANARY;
    process.env.PROVIDER_SECRET_CANARY = 'real-key-canary';
    try {
      const dependencies = fakeDependencies();
      const runtime = createReplayRuntimeInternal({}, dependencies);
      const prepared = await runtime.prepare({ bundle: sealedBundle() });
      if (!prepared.ok) throw new Error('fixture did not prepare');
      const result = await prepared.prepared.execute({
        terminalInput: 'terminal',
        route: matchingRoute('claude-code'),
        environment: { ANTHROPIC_API_KEY: 'real-key-canary' },
      } as never);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'runtime-policy-unsupported' },
      });
      expect(dependencies.processCalls).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('real-key-canary');
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_SECRET_CANARY;
      else process.env.PROVIDER_SECRET_CANARY = previous;
    }
  });

  it('rejects terminal UTF-8 byte overflow before launch', async () => {
    const dependencies = fakeDependencies();
    const runtime = createReplayRuntimeInternal(
      { limits: { terminalInputBytes: 4 } },
      dependencies,
    );
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: '五个字节',
      route: matchingRoute('claude-code'),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'terminal-input-invalid' },
    });
    expect(dependencies.processCalls).not.toHaveBeenCalled();
  });

  it('uses exactly one Codex resume plan and never retries a failure', async () => {
    const dependencies = fakeDependencies('codex');
    dependencies.processCalls.mockRejectedValueOnce(
      Object.assign(new Error('echo body/token'), {
        code: 'process-exit-failed',
        stage: 'run',
        sourceCli: 'codex',
        replayCliVersion: '0.101.8',
      }),
    );
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({
      bundle: sealedBundle('codex'),
    });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: 'codex terminal',
      route: matchingRoute('codex'),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'process-spawn-failed', cleanup: 'complete' },
    });
    expect(dependencies.processCalls).toHaveBeenCalledTimes(1);
    const [plan] = dependencies.processCalls.mock.calls[0]!;
    expect(plan.argv).toEqual([
      'exec',
      'resume',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'session-1',
      '-',
    ]);
    expect(plan.environment.CODEX_HOME).toContain('.codex');
    expect(JSON.stringify(result)).not.toContain('body/token');
  });

  it('lets cleanup failure override an otherwise successful execution', async () => {
    const dependencies = fakeDependencies();
    dependencies.cleanupCalls.mockRejectedValueOnce(
      new Error('private cleanup path'),
    );
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: 'terminal',
      route: matchingRoute('claude-code'),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'cleanup-failed',
        stage: 'cleanup',
        sourceCli: 'claude-code',
        replayCliVersion: '2.1.9',
        cleanup: 'failed',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private cleanup path');
  });

  it('does not delete a workspace while process-tree termination is unconfirmed', async () => {
    const dependencies = fakeDependencies();
    dependencies.processCalls.mockRejectedValueOnce(
      new RuntimeFault(
        'cleanup-failed',
        'terminate',
        'claude-code',
        '2.1.9',
      ),
    );
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const prepared = await runtime.prepare({ bundle: sealedBundle() });
    if (!prepared.ok) throw new Error('fixture did not prepare');
    const result = await prepared.prepared.execute({
      terminalInput: 'terminal',
      route: matchingRoute('claude-code'),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'cleanup-failed',
        stage: 'terminate',
        sourceCli: 'claude-code',
        replayCliVersion: '2.1.9',
        cleanup: 'failed',
      },
    });
    expect(dependencies.cleanupCalls).not.toHaveBeenCalled();
    const disposal = await prepared.prepared.dispose();
    expect(disposal).toMatchObject({
      ok: false,
      error: { code: 'cleanup-failed', stage: 'terminate' },
    });
    expect(dependencies.cleanupCalls).not.toHaveBeenCalled();
  });

  it('cleans partial preparation state after skill exposure refusal', async () => {
    const dependencies = fakeDependencies();
    dependencies.exposeSkills = vi.fn(async () => {
      throw new RuntimeFault(
        'skill-exposure-failed',
        'materialize',
        'claude-code',
        '2.1.9',
      );
    });
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const result = await runtime.prepare({ bundle: sealedBundle() });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'skill-exposure-failed',
        cleanup: 'complete',
      },
    });
    expect(dependencies.cleanupCalls).toHaveBeenCalledTimes(1);
  });

  it('claims a partial replay root before workspace creation rejects and lets deletion failure override', async () => {
    const dependencies = fakeDependencies();
    dependencies.createWorkspace = vi.fn(
      async (_config, _validated, _profile, claimOwnership) => {
        claimOwnership(
          Object.freeze({
            root: path.resolve('partial-replay-root'),
            rootId: 'partial-root',
          }),
        );
        throw new RuntimeFault(
          'workspace-materialize-failed',
          'materialize',
          'claude-code',
          '2.1.9',
        );
      },
    );
    dependencies.cleanupCalls.mockRejectedValueOnce(
      new Error('deletion refused'),
    );
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const result = await runtime.prepare({ bundle: sealedBundle() });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'cleanup-failed',
        stage: 'cleanup',
        sourceCli: 'claude-code',
        replayCliVersion: '2.1.9',
        cleanup: 'failed',
      },
    });
    expect(dependencies.cleanupCalls).toHaveBeenCalledTimes(1);
    expect(dependencies.cleanupCalls.mock.calls[0]![0]).toMatchObject({
      rootId: 'partial-root',
    });
  });

  it('consumes and cleans when the executable identity changes across the probe', async () => {
    const dependencies = fakeDependencies();
    const stable =
      await dependencies.captureExecutable(path.resolve('fake-cli.exe'), 'claude-code');
    const replaced = Object.freeze({
      ...stable,
      inode: '2',
      digest: `sha256:${'b'.repeat(64)}` as const,
    });
    // identityBeforeProbe = stable; identityAfterProbe = replaced → the
    // prepare-level stability check refuses (cli-probe-failed) and cleans up.
    // (The check/use gap between comparison and spawn is closed separately by
    // the owned-executable copy + verifyOwnedExecutable, covered by
    // owned-executable.test.ts.)
    vi.mocked(dependencies.captureExecutable)
      .mockResolvedValueOnce(stable)
      .mockResolvedValueOnce(replaced);
    const runtime = createReplayRuntimeInternal({}, dependencies);
    const result = await runtime.prepare({ bundle: sealedBundle() });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'cli-probe-failed',
        stage: 'probe',
        cleanup: 'not-created',
      },
    });
    expect(dependencies.processCalls).not.toHaveBeenCalled();
  });
});
