import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  captureExecutableIdentity,
  parseProbeEvidence,
} from '../adapters/capabilityProbe.js';
import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import { CODEX_PROFILE } from '../adapters/codex.js';
import { runtimeAdapterFor } from '../adapters/registry.js';
import { normalizeRuntimeOptions } from '../config.js';
import { stageOwnedExecutable, type OwnedExecutable } from '../ownedExecutable.js';
import { superviseProbeProcess } from '../processSupervisor.js';

const directories: string[] = [];
const fixtureDirectories: string[] = [];

async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'mosga-probe-test-'));
  directories.push(value);
  return value;
}

let cachedNodeOwned: OwnedExecutable | null = null;
async function nodeOwnedFixture(): Promise<OwnedExecutable> {
  if (cachedNodeOwned !== null) return cachedNodeOwned;
  const dir = await mkdtemp(path.join(tmpdir(), 'mosga-probe-node-'));
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

function probeEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot !== undefined) {
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
  }
  return env;
}

afterEach(async () => {
  for (const value of directories.splice(0)) {
    await rm(value, { recursive: true, force: true });
  }
});

afterAll(async () => {
  cachedNodeOwned = null;
  for (const value of fixtureDirectories) {
    await rm(value, { recursive: true, force: true }).catch(() => {});
  }
});

describe('captured capability fixtures', () => {
  it.each([
    [
      'claude-code' as const,
      CLAUDE_CODE_PROFILE,
      [
        'claude-code-2.1.version.txt',
        'claude-code-2.1.help.txt',
      ],
      '2.1.9',
    ],
    [
      'codex' as const,
      CODEX_PROFILE,
      [
        'codex-0.101.version.txt',
        'codex-0.101.help.txt',
        'codex-0.101.exec-help.txt',
      ],
      '0.101.8',
    ],
  ])(
    'parses the sanitized %s version/help fixture',
    async (source, profile, fixtureFiles, expectedVersion) => {
      const fixtureRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'fixtures',
        'profiles',
      );
      const outputs = await Promise.all(
        fixtureFiles.map((file) =>
          readFile(path.join(fixtureRoot, file), 'utf8'),
        ),
      );
      const evidence = parseProbeEvidence(
        runtimeAdapterFor(source),
        outputs,
      );
      expect(evidence.version).toBe(expectedVersion);
      expect([...evidence.normalizedMarkers].sort()).toEqual(
        [...profile.requiredMarkers].sort(),
      );
      expect(JSON.stringify(evidence)).not.toContain(outputs.join(''));
    },
  );

  it('uses only fixed version/help probes with no session, prompt, or route data', () => {
    for (const profile of [CLAUDE_CODE_PROFILE, CODEX_PROFILE]) {
      for (const command of profile.probeCommands) {
        const joined = command.argv.join(' ');
        expect(joined).not.toContain('session-1');
        expect(joined).not.toContain('terminal');
        expect(joined).not.toContain('route');
        expect(joined).not.toContain('token');
        expect(
          command.argv.includes('--version') ||
            command.argv.includes('--help'),
        ).toBe(true);
      }
    }
  });

  it.each([
    [
      'duplicate identity',
      ['Claude Code 2.1.9\nClaude Code 2.1.9', ''],
    ],
    [
      'conflicting identity',
      ['Claude Code 2.1.9\nClaude Code 2.2.0', ''],
    ],
    [
      'decorated identity',
      ['version: Claude Code 2.1.9', ''],
    ],
    [
      'error identity',
      ['ERROR Claude Code 2.1.9', ''],
    ],
  ])('rejects %s version evidence', (_name, outputs) => {
    expect(() =>
      parseProbeEvidence(runtimeAdapterFor('claude-code'), outputs),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
  });

  it.each([
    'unsupported capability: --resume',
    '[enabled] --resume <session-id>',
    'ERROR: stdin prompt supported',
    '--resume <session-id> (maybe)',
  ])('rejects negative or decorated capability evidence: %s', (line) => {
    expect(() =>
      parseProbeEvidence(runtimeAdapterFor('claude-code'), [
        'Claude Code 2.1.9',
        [
          'Usage: claude [options]',
          '--print',
          line,
          '--dangerously-skip-permissions',
          'stdin prompt supported',
          'isolated-home supported',
          'ANTHROPIC_BASE_URL route override',
        ].join('\n'),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
  });

  it('rejects incomplete and command-conflicted evidence', () => {
    const codex = runtimeAdapterFor('codex');
    expect(() =>
      parseProbeEvidence(codex, [
        'codex-cli 0.101.8',
        'CODEX_HOME isolated',
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
    expect(() =>
      parseProbeEvidence(codex, [
        'codex-cli 0.101.8',
        [
          'CODEX_HOME isolated',
          'exec resume <session-id> -',
        ].join('\n'),
        'stdin prompt supported',
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
    expect(() =>
      parseProbeEvidence(runtimeAdapterFor('claude-code'), [
        'Claude Code 2.1.9',
        [
          'Usage: claude [options]',
          'Claude Code 2.1.9',
          '--print',
        ].join('\n'),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'cli-probe-failed' }),
    );
  });
});

describe('bounded probe process behavior', () => {
  it('terminates a hanging probe at its deadline', { retry: 2, timeout: 60_000 }, async () => {
    const nodeOwned = await nodeOwnedFixture();
    const config = normalizeRuntimeOptions({
      limits: { probeTimeoutMs: 150 },
    });
    await expect(
      superviseProbeProcess(
        nodeOwned,
        { id: 'hang', argv: ['-e', 'setInterval(() => {}, 1000)'] },
        await directory(),
        probeEnv(await directory()),
        config,
        'claude-code',
        [],
      ),
    ).rejects.toMatchObject({ code: 'cli-probe-failed' });
  });

  it('terminates a probe whose combined output exceeds the cap', async () => {
    const nodeOwned = await nodeOwnedFixture();
    const config = normalizeRuntimeOptions({
      limits: { probeOutputBytes: 64 },
    });
    await expect(
      superviseProbeProcess(
        nodeOwned,
        { id: 'oversize', argv: ['-e', 'process.stdout.write("x".repeat(1024))'] },
        await directory(),
        probeEnv(await directory()),
        config,
        'claude-code',
        [],
      ),
    ).rejects.toMatchObject({ code: 'cli-probe-failed' });
  });

  it('honors pre-abort without spawning a probe', async () => {
    const nodeOwned = await nodeOwnedFixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      superviseProbeProcess(
        nodeOwned,
        { id: 'version', argv: ['--version'] },
        await directory(),
        probeEnv(await directory()),
        normalizeRuntimeOptions({}),
        'claude-code',
        [abort.signal],
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
