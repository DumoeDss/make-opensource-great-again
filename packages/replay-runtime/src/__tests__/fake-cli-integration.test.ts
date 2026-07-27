import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createReplayRuntime } from '../index.js';
import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import { CODEX_PROFILE } from '../adapters/codex.js';
import { captureExecutableIdentity } from '../adapters/capabilityProbe.js';
import {
  stageOwnedExecutable,
  type OwnedExecutable,
} from '../ownedExecutable.js';
import {
  superviseReplayProcess,
} from '../processSupervisor.js';
import {
  createReplayRuntimeInternal,
  type RuntimeDependencies,
} from '../runtime.js';
import { exposeSkillSnapshots } from '../skills.js';
import {
  cleanupReplayWorkspace,
  cleanupStaleReplayRoots,
  createReplayWorkspace,
} from '../workspace.js';
import { sealedBundle } from './fixtures.js';

const temporaryDirectories: string[] = [];
const fixtureDirectories: string[] = [];
const terminalInput = 'terminal-e2e-canary';

/**
 * Windows temp-dir cleanup that tolerates the OS-level handle-release lag after
 * a child process exits (EBUSY/EPERM/ENOTEMPTY from antivirus, search indexer,
 * or the kernel itself releasing the executable image). Under the full repo's
 * parallel load this lag is amplified; a plain rm fails ~50% of the time.
 * Retries with a short back-off for a bounded grace window, then rethrows.
 */
async function rmWithRetry(target: string): Promise<void> {
  const maxAttempts = 40;
  const delayMs = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt < maxAttempts - 1 &&
        (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')
      ) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
}
const routeToken = 'opaque-e2e-route-token';
const cliModel = 'target-cli-model';

// A staged copy of node.exe that passes verifyOwnedExecutable inside the real
// supervisor. The system node install often fails captureExecutableIdentity
// (realpath mismatch through version-manager shims), so stage a clean copy.
let cachedNodeOwned: OwnedExecutable | null = null;
async function nodeOwnedFixture(): Promise<OwnedExecutable> {
  if (cachedNodeOwned !== null) return cachedNodeOwned;
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-fake-cli-node-'));
  fixtureDirectories.push(dir);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const nodeCopy = path.join(dir, `node${ext}`);
  await copyFile(process.execPath, nodeCopy);
  if (process.platform !== 'win32') await chmod(nodeCopy, 0o755);
  const identity = await captureExecutableIdentity(nodeCopy, 'claude-code');
  cachedNodeOwned = await stageOwnedExecutable(
    nodeCopy,
    dir,
    identity,
    'claude-code',
  );
  return cachedNodeOwned;
}

afterEach(async () => {
  delete process.env.PROVIDER_SECRET_E2E_CANARY;
  for (const directory of temporaryDirectories.splice(0)) {
    await rmWithRetry(directory);
  }
});

afterAll(async () => {
  cachedNodeOwned = null;
  for (const directory of fixtureDirectories) {
    await rmWithRetry(directory).catch(() => {});
  }
});

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
    routeToken,
    cliModel,
  };
}

function fakeCliSource(
  source: 'claude-code' | 'codex',
  includeProbeBehavior: boolean,
  failAfterContract = false,
): string {
  const expectedArgv =
    source === 'claude-code'
      ? [
          '--print',
          '--resume',
          'session-1',
          '--output-format',
          'json',
          '--dangerously-skip-permissions',
        ]
      : [
          'exec',
          'resume',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          'session-1',
          '-',
        ];
  const version =
    source === 'claude-code'
      ? 'Claude Code 2.1.9'
      : 'codex-cli 0.101.8';
  const help =
    source === 'claude-code'
      ? [
          'Usage: claude [options]',
          '--print',
          '--resume <session-id>',
          '--dangerously-skip-permissions',
          'stdin prompt supported',
          'isolated-home supported',
          'ANTHROPIC_BASE_URL route override',
        ].join('\n')
      : [
          'Usage: codex [options]',
          'CODEX_HOME isolated',
          'model_provider config supported',
          'base_url_env config supported',
          'env_key config supported',
          'wire_api = responses',
        ].join('\n');
  const execHelp = [
    'Usage: codex exec [options]',
    'exec resume <session-id> -',
    'stdin prompt supported',
  ].join('\n');
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const source = ${JSON.stringify(source)};`,
    `const probeAware = ${JSON.stringify(includeProbeBehavior)};`,
    `const failAfterContract = ${JSON.stringify(failAfterContract)};`,
    'const argv = process.argv.slice(2);',
    `if (probeAware && argv.length === 1 && argv[0] === '--version') { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }`,
    `if (probeAware && argv.length === 1 && argv[0] === '--help') { process.stdout.write(${JSON.stringify(help)} + '\\n'); process.exit(0); }`,
    `if (probeAware && source === 'codex' && JSON.stringify(argv) === JSON.stringify(['exec', '--help'])) { process.stdout.write(${JSON.stringify(execHelp)} + '\\n'); process.exit(0); }`,
    `const expectedArgv = ${JSON.stringify(expectedArgv)};`,
    'const chunks = [];',
    "process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));",
    "process.stdin.on('end', () => {",
    '  try {',
    "    if (JSON.stringify(argv) !== JSON.stringify(expectedArgv)) throw new Error('argv');",
    `    if (Buffer.concat(chunks).toString('utf8') !== ${JSON.stringify(terminalInput)}) throw new Error('stdin');`,
    "    if (process.env.PROVIDER_SECRET_E2E_CANARY !== undefined) throw new Error('parent-env');",
    `    if (source === 'claude-code' && process.env.ANTHROPIC_AUTH_TOKEN !== ${JSON.stringify(routeToken)}) throw new Error('route-token');`,
    `    if (source === 'claude-code' && process.env.ANTHROPIC_MODEL !== ${JSON.stringify(cliModel)}) throw new Error('model');`,
    `    if (source === 'codex' && process.env.MOSGA_ROUTE_TOKEN !== ${JSON.stringify(routeToken)}) throw new Error('route-token');`,
    `    if (source === 'codex' && process.env.MOSGA_CLI_MODEL !== ${JSON.stringify(cliModel)}) throw new Error('model');`,
    "    const native = source === 'claude-code'",
    "      ? path.join(process.env.HOME, '.claude', 'projects', 'workspace-project-1', 'session-1.jsonl')",
    "      : path.join(process.env.CODEX_HOME, 'sessions', 'replay', 'session-1', 'rollout-session-1.jsonl');",
    "    const nativeRows = fs.readFileSync(native, 'utf8').trim().split('\\n');",
    '    if (nativeRows.length === 0) throw new Error(\'native-empty\');',
    '    for (const row of nativeRows) JSON.parse(row);',
    "    const instruction = path.join(process.cwd(), '..', 'CLAUDE.md');",
    "    if ((fs.statSync(instruction).mode & 0o222) !== 0) throw new Error('instruction-writable');",
    "    const skill = source === 'claude-code'",
    "      ? path.join(process.env.HOME, '.claude', 'skills', 'SKILL.md')",
    "      : path.join(process.env.CODEX_HOME, 'skills', 'SKILL.md');",
    "    if ((fs.statSync(skill).mode & 0o222) !== 0) throw new Error('skill-writable');",
    "    fs.writeFileSync(path.join(process.cwd(), 'cli-cwd-write.txt'), 'contained');",
    "    fs.writeFileSync(path.join(process.env.HOME, 'cli-home-write.txt'), 'contained');",
    '    if (failAfterContract) process.exitCode = 42;',
    `    require('node:fs').writeFileSync(${JSON.stringify(path.join(tmpdir(), 'mosga-fake-cli-err.txt'))}, 'OK exitCode=' + process.exitCode);`,
    '  } catch (e) {',
    `    require('node:fs').writeFileSync(${JSON.stringify(path.join(tmpdir(), 'mosga-fake-cli-err.txt'))}, 'ERR ' + String(e && e.message));`,
    '    process.exitCode = 41;',
    '  }',
    '});',
    '',
  ].join('\n');
}

async function fixtureRoot(): Promise<{
  parent: string;
  skillRoot: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), 'mosga-fake-cli-e2e-'));
  temporaryDirectories.push(parent);
  const skillRoot = path.join(parent, 'selected-skills');
  await mkdir(skillRoot);
  await writeFile(
    path.join(skillRoot, 'SKILL.md'),
    'description-canary\nbody-canary',
  );
  return { parent, skillRoot };
}

describe('executable fake Claude/Codex contracts', () => {
  it.each(['claude-code', 'codex'] as const)(
    'executes the %s argv/stdin/env/layout contract through the real supervisor',
    // 90s: under full-suite parallel load the verifyOwnedExecutable re-hash of
    // the ~75MB owned node copy + fake-CLI Node startup + workspace cleanup
    // chain can exceed 60s under extreme contention. Well within the 120s
    // no-hang cap. The rmWithRetry in afterEach handles the handle-release lag.
    { timeout: 90_000 },
    async (source) => {
      const { parent, skillRoot } = await fixtureRoot();
      const script = path.join(parent, `${source}-fake.cjs`);
      await writeFile(script, fakeCliSource(source, false));
      process.env.PROVIDER_SECRET_E2E_CANARY = 'must-not-inherit';
      const profile =
        source === 'claude-code'
          ? CLAUDE_CODE_PROFILE
          : CODEX_PROFILE;
      const identity = Object.freeze({
        path: path.resolve(parent, 'fake-cli.exe'),
        device: '1',
        inode: '1',
        size: '1',
        modifiedNanoseconds: '1',
        changedNanoseconds: '1',
        digest: `sha256:${'a'.repeat(64)}` as const,
      });
      let replayRoot: string | null = null;
      let launchCount = 0;
      const dependencies: RuntimeDependencies = {
        resolveBinary: async () => identity.path,
        captureExecutable: async () => identity,
        stageOwnedExecutable: async (p, _d, id) =>
          Object.freeze({ runtimePath: p, identity: id }),
        probe: async () => ({
          sourceCli: source,
          version: source === 'claude-code' ? '2.1.9' : '0.101.8',
          normalizedMarkers: new Set(profile.requiredMarkers),
        }),
        async createWorkspace(config, validated, selected, claim) {
          const workspace = await createReplayWorkspace(
            config,
            validated,
            selected,
            claim,
          );
          replayRoot = workspace.paths.root;
          return workspace;
        },
        exposeSkills: exposeSkillSnapshots,
        async supervise(
          plan,
          stdinBytes,
          timeoutMs,
          signals,
          config,
          sourceCli,
          replayCliVersion,
        ) {
          launchCount += 1;
          expect(plan.argv).toEqual(
            source === 'claude-code'
              ? [
                  '--print',
                  '--resume',
                  'session-1',
                  '--output-format',
                  'json',
                  '--dangerously-skip-permissions',
                ]
              : [
                  'exec',
                  'resume',
                  '--skip-git-repo-check',
                  '--dangerously-bypass-approvals-and-sandbox',
                  'session-1',
                  '-',
                ],
          );
          const nodeOwned = await nodeOwnedFixture();
          return await superviseReplayProcess(
            {
              ...plan,
              executable: nodeOwned,
              argv: [script, ...plan.argv],
            },
            stdinBytes,
            timeoutMs,
            signals,
            config,
            sourceCli,
            replayCliVersion,
          );
        },
        cleanup: cleanupReplayWorkspace,
        staleCleanup: cleanupStaleReplayRoots,
      };
      const runtime = createReplayRuntimeInternal(
        { tempBase: parent },
        dependencies,
      );
      const originalSkill = await readFile(
        path.join(skillRoot, 'SKILL.md'),
        'utf8',
      );
      const prepared = await runtime.prepare({
        bundle: sealedBundle(source),
        skillRoots: [
          {
            id: 'fixture-skill',
            sourcePath: skillRoot,
            scope: 'user',
            precedence: 0,
          },
        ],
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const result = await prepared.prepared.execute({
        terminalInput,
        route: matchingRoute(source),
      });
      if (!result.ok) {
        try { console.log('DEBUG script error:', await readFile(path.join(tmpdir(), 'mosga-fake-cli-err.txt'), 'utf8')); } catch { console.log('no err file'); }
      }
      expect(result).toMatchObject({ ok: true });
      expect(launchCount).toBe(1);
      expect(replayRoot).not.toBeNull();
      await expect(readdir(replayRoot!)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(
        await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
      ).toBe(originalSkill);
    },
  );

  it.each(['claude-code', 'codex'] as const)(
    'launches no alternate %s invocation after executable fake-CLI refusal',
    { timeout: 90_000 },
    async (source) => {
      const { parent, skillRoot } = await fixtureRoot();
      const script = path.join(parent, `${source}-refusal.cjs`);
      await writeFile(script, fakeCliSource(source, false, true));
      const profile =
        source === 'claude-code'
          ? CLAUDE_CODE_PROFILE
          : CODEX_PROFILE;
      const identity = Object.freeze({
        path: path.resolve(parent, 'fake-cli.exe'),
        device: '1',
        inode: '1',
        size: '1',
        modifiedNanoseconds: '1',
        changedNanoseconds: '1',
        digest: `sha256:${'a'.repeat(64)}` as const,
      });
      let launchCount = 0;
      const dependencies: RuntimeDependencies = {
        resolveBinary: async () => identity.path,
        captureExecutable: async () => identity,
        stageOwnedExecutable: async (p, _d, id) =>
          Object.freeze({ runtimePath: p, identity: id }),
        probe: async () => ({
          sourceCli: source,
          version: source === 'claude-code' ? '2.1.9' : '0.101.8',
          normalizedMarkers: new Set(profile.requiredMarkers),
        }),
        createWorkspace: createReplayWorkspace,
        exposeSkills: exposeSkillSnapshots,
        async supervise(
          plan,
          stdinBytes,
          timeoutMs,
          signals,
          config,
          sourceCli,
          replayCliVersion,
        ) {
          launchCount += 1;
          const nodeOwned = await nodeOwnedFixture();
          return await superviseReplayProcess(
            {
              ...plan,
              executable: nodeOwned,
              argv: [script, ...plan.argv],
            },
            stdinBytes,
            timeoutMs,
            signals,
            config,
            sourceCli,
            replayCliVersion,
          );
        },
        cleanup: cleanupReplayWorkspace,
        staleCleanup: cleanupStaleReplayRoots,
      };
      const runtime = createReplayRuntimeInternal(
        { tempBase: parent },
        dependencies,
      );
      const prepared = await runtime.prepare({
        bundle: sealedBundle(source),
        skillRoots: [
          {
            id: 'fixture-skill',
            sourcePath: skillRoot,
            scope: 'user',
            precedence: 0,
          },
        ],
      });
      if (!prepared.ok) throw new Error('fixture did not prepare');
      const result = await prepared.prepared.execute({
        terminalInput,
        route: matchingRoute(source),
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'process-exit-failed',
          cleanup: 'complete',
        },
      });
      expect(launchCount).toBe(1);
    },
  );

  it.skipIf(process.platform === 'win32').each([
    'claude-code',
    'codex',
  ] as const)(
    'drives the actual public %s runtime with a self-contained fake executable',
    async (source) => {
      const { parent, skillRoot } = await fixtureRoot();
      const executable = path.join(parent, source);
      await writeFile(
        executable,
        `#!${process.execPath}\n${fakeCliSource(source, true)}`,
      );
      await chmod(executable, 0o700);
      const runtime = createReplayRuntime({
        tempBase: parent,
        binaryOverrides: { [source]: executable },
      });
      const prepared = await runtime.prepare({
        bundle: sealedBundle(source),
        skillRoots: [
          {
            id: 'fixture-skill',
            sourcePath: skillRoot,
            scope: 'user',
            precedence: 0,
          },
        ],
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const result = await prepared.prepared.execute({
        terminalInput,
        route: matchingRoute(source),
      });
      expect(result).toMatchObject({ ok: true });
      const dedicated = path.join(parent, 'mosga-replay-runtime-v1');
      expect(await readdir(dedicated)).toEqual([]);
    },
  );
});
