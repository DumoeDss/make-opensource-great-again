import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureExecutableIdentity,
  executableIdentityMatches,
} from '../adapters/capabilityProbe.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('probed executable identity', () => {
  it('accepts a stable opened-file identity and rejects same-path replacement', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'mosga-executable-identity-'),
    );
    temporaryDirectories.push(directory);
    const executable = path.join(
      directory,
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    await writeFile(executable, 'first-executable');
    if (process.platform !== 'win32') await chmod(executable, 0o700);

    const first = await captureExecutableIdentity(
      executable,
      'claude-code',
    );
    const stable = await captureExecutableIdentity(
      executable,
      'claude-code',
    );
    expect(executableIdentityMatches(first, stable)).toBe(true);

    await rm(executable);
    await writeFile(executable, 'other-executable');
    if (process.platform !== 'win32') await chmod(executable, 0o700);
    const replaced = await captureExecutableIdentity(
      executable,
      'claude-code',
    );
    expect(replaced.path).toBe(first.path);
    expect(executableIdentityMatches(first, replaced)).toBe(false);
  });
});
