// STD-B1 adversarial test: proves every security-relevant execution field is
// read EXACTLY ONCE into the owned immutable snapshot.
//
// A Proxy-backed route returns a valid loopback URL on the first read of
// `baseUrl` and a remote attacker URL on every subsequent read; a getter-backed
// `terminalInput` returns the real canary on the first read and a decoy on
// every subsequent read. If any field were re-read after capture (the
// round-1/2/3 check/use gap at executionInput.ts/runtime.ts/environment.ts),
// the remote URL or the decoy would leak into the launch plan, and the
// per-field read counter would exceed 1. The test fails on either signal.
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import type { RuntimeDependencies } from '../runtime.js';
import { createReplayRuntimeInternal } from '../runtime.js';
import type { ReplayRouteBinding } from '../types.js';
import { sealedBundle } from './fixtures.js';

const LOOPBACK = 'http://127.0.0.1:43123/v1';
const REMOTE = 'http://attacker.example:43123/v1';
const TERMINAL_CANARY = 'terminal-sensitive-canary';
const TERMINAL_DECOY = 'terminal-decoy-canary';

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

function fakeDependencies(): RuntimeDependencies & {
  processCalls: ReturnType<typeof vi.fn>;
} {
  const executableIdentity = Object.freeze({
    path: path.resolve('fake-cli.exe'),
    device: '1',
    inode: '1',
    size: '1',
    modifiedNanoseconds: '1',
    changedNanoseconds: '1',
    digest: `sha256:${'a'.repeat(64)}` as const,
  });
  const processCalls = vi.fn(async () => ({
    startedAtMs: 1_000,
    completedAtMs: 1_025,
    exitStatus: 0 as const,
  }));
  return {
    resolveBinary: vi.fn(async () => path.resolve('fake-cli.exe')),
    captureExecutable: vi.fn(async () => executableIdentity),
    stageOwnedExecutable: vi.fn(
      async (originalPath: string, _dir: string, probedIdentity: typeof executableIdentity) =>
        Object.freeze({
          runtimePath: originalPath,
          identity: probedIdentity,
        }),
    ),
    probe: vi.fn(async () => ({
      sourceCli: 'claude-code' as const,
      version: '2.1.9',
      normalizedMarkers: new Set(CLAUDE_CODE_PROFILE.requiredMarkers),
    })),
    createWorkspace: vi.fn(async () => fakeWorkspace()),
    exposeSkills: vi.fn(async () => {}),
    supervise: processCalls,
    cleanup: vi.fn(async () => {}),
    staleCleanup: vi.fn(async () => {}),
    processCalls,
  };
}

describe('owned launch snapshot (STD-B1)', () => {
  it('reads every security-relevant execution field exactly once', async () => {
    const deps = fakeDependencies();
    const runtime = createReplayRuntimeInternal({}, deps);
    const preparedResult = await runtime.prepare({ bundle: sealedBundle() });
    if (!preparedResult.ok) throw new Error('fixture did not prepare');

    // --- Adversarial input: proxy route + getter terminalInput ---
    // Each route scalar getter increments a per-field counter. baseUrl returns
    // the loopback URL on the FIRST read and a remote attacker URL on every
    // subsequent read. If any downstream stage re-reads baseUrl after capture,
    // it gets the attacker URL and the counter exceeds 1.
    const reads: Record<keyof ReplayRouteBinding, number> = {
      sourceCli: 0,
      wireProtocol: 0,
      transport: 0,
      authScheme: 0,
      targetProviderId: 0,
      targetModel: 0,
      baseUrl: 0,
      routeToken: 0,
      cliModel: 0,
    };
    const baseRoute: ReplayRouteBinding = {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'target-provider',
      targetModel: 'target-model',
      baseUrl: LOOPBACK,
      routeToken: 'opaque-route-token',
      cliModel: 'target-cli-model',
    };
    const route = new Proxy(baseRoute, {
      get(target, prop, receiver) {
        if (prop in reads) {
          const key = prop as keyof ReplayRouteBinding;
          reads[key] += 1;
          if (key === 'baseUrl' && reads.baseUrl > 1) {
            return REMOTE;
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // terminalInput getter: real canary on first read, decoy after. If any
    // downstream stage re-reads terminalInput after capture (collision check,
    // environment build, stdin delivery), it gets the decoy and the counter
    // exceeds 1.
    let terminalReads = 0;
    let routeReads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'terminalInput', {
      enumerable: true,
      configurable: true,
      get() {
        terminalReads += 1;
        return terminalReads === 1 ? TERMINAL_CANARY : TERMINAL_DECOY;
      },
    });
    Object.defineProperty(input, 'route', {
      enumerable: true,
      configurable: true,
      get() {
        routeReads += 1;
        return route;
      },
    });

    const result = await preparedResult.prepared.execute(input as never);
    expect(result).toMatchObject({ ok: true });

    // --- Assertion 1: every field counter === 1 ---
    for (const [field, count] of Object.entries(reads)) {
      expect(count, `route.${field} must be read exactly once`).toBe(1);
    }
    expect(terminalReads, 'terminalInput must be read exactly once').toBe(1);
    expect(routeReads, 'input.route must be read exactly once').toBe(1);

    // --- Assertion 2: the spawn host saw the loopback URL + real canary ---
    expect(deps.processCalls).toHaveBeenCalledTimes(1);
    const [plan, stdinBytes] = deps.processCalls.mock.calls[0]!;
    expect(plan.environment.ANTHROPIC_BASE_URL).toBe(LOOPBACK);
    expect(plan.environment.ANTHROPIC_BASE_URL).not.toBe(REMOTE);
    expect(new TextDecoder().decode(stdinBytes)).toBe(TERMINAL_CANARY);

    // --- Assertion 3: the remote attacker URL never reached the launch plan ---
    expect(JSON.stringify(plan)).not.toContain(REMOTE);
    expect(JSON.stringify(plan)).not.toContain('attacker.example');

    // --- Assertion 4: no argv/env value contains the terminal canary ---
    expect(JSON.stringify(plan.argv)).not.toContain(TERMINAL_CANARY);
    expect(JSON.stringify(plan.environment)).not.toContain(TERMINAL_CANARY);

    // --- Assertion 5: the decoy terminal value never reached the launch plan ---
    expect(JSON.stringify(plan)).not.toContain(TERMINAL_DECOY);
  });
});
