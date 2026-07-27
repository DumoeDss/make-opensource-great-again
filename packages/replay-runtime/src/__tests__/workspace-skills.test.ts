import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  serializeInstructionFile,
  serializeNativeJsonl,
} from '@mosga/replay-bundle';

import { CLAUDE_CODE_PROFILE } from '../adapters/claudeCode.js';
import { CODEX_PROFILE } from '../adapters/codex.js';
import { normalizeRuntimeOptions } from '../config.js';
import { exposeSkillSnapshots } from '../skills.js';
import { validateAndBrandReplayBundle } from '../validated.js';
import {
  cleanupReplayWorkspace,
  cleanupStaleReplayRoots,
  createReplayWorkspace,
  type ReplayRootOwnership,
} from '../workspace.js';
import { sealedBundle } from './fixtures.js';

const temporaryParents: string[] = [];

async function tempParent(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), 'mosga-runtime-test-'));
  temporaryParents.push(created);
  return created;
}

afterEach(async () => {
  for (const directory of temporaryParents.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('private canonical workspace', () => {
  it('stages canonical native and exact sealed instruction bytes in an isolated root', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const bundle = sealedBundle();
    const before = structuredClone(bundle);
    const validated = validateAndBrandReplayBundle(bundle);
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    const storage = CLAUDE_CODE_PROFILE.storagePlan(validated);

    expect(
      await readFile(
        path.join(workspace.paths.root, storage.nativeFiles[0]!.relativePath),
      ),
    ).toEqual(
      Buffer.from(
        serializeNativeJsonl(
          validated.payload.nativeSession.files[0]!,
        ),
      ),
    );
    const instruction =
      validated.payload.instructionSnapshot.files[0]!;
    expect(
      await readFile(
        path.join(workspace.paths.root, instruction.stagePath),
      ),
    ).toEqual(Buffer.from(serializeInstructionFile(instruction)));
    expect(workspace.inventory).toHaveLength(
      validated.payload.nativeSession.files.length +
        validated.payload.instructionSnapshot.files.length,
    );
    expect(bundle).toEqual(before);
    expect(workspace.paths.root).toContain(
      path.join('mosga-replay-runtime-v1', 'replay-'),
    );
    if (process.platform !== 'win32') {
      expect((await lstat(workspace.paths.root)).mode & 0o077).toBe(0);
    }

    await cleanupReplayWorkspace(workspace, config);
    await expect(lstat(workspace.paths.root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('writes the exact allowlisted Codex provider control file without token or body', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const validated = validateAndBrandReplayBundle(
      sealedBundle('codex'),
    );
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CODEX_PROFILE,
      () => {},
    );
    const control = await readFile(
      path.join(workspace.paths.cliHome, '.codex', 'config.toml'),
      'utf8',
    );
    expect(control).toContain('base_url_env = "MOSGA_ROUTE_BASE_URL"');
    expect(control).toContain('env_key = "MOSGA_ROUTE_TOKEN"');
    expect(control).toContain('wire_api = "responses"');
    expect(control).not.toContain('opaque-route-token');
    expect(control).not.toContain('hello');
    expect(control).not.toContain('reviewed instructions');
    await cleanupReplayWorkspace(workspace, config);
  });
});

describe('detached bounded skill snapshots', () => {
  it('merges ordered roots into native discovery locations without aliasing source files', async () => {
    const parent = await tempParent();
    const sourceA = path.join(parent, 'skills-a');
    const sourceB = path.join(parent, 'skills-b');
    await mkdir(path.join(sourceA, 'alpha'), { recursive: true });
    await mkdir(path.join(sourceB, 'beta'), { recursive: true });
    await writeFile(
      path.join(sourceA, 'alpha', 'SKILL.md'),
      'description-canary\nbody-canary-a',
    );
    await writeFile(
      path.join(sourceB, 'beta', 'SKILL.md'),
      'body-canary-b',
    );
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const validated = validateAndBrandReplayBundle(sealedBundle());
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );

    await exposeSkillSnapshots(
      [
        {
          id: 'second',
          sourcePath: sourceB,
          scope: 'user',
          precedence: 2,
        },
        {
          id: 'first',
          sourcePath: sourceA,
          scope: 'user',
          precedence: 1,
        },
      ],
      CLAUDE_CODE_PROFILE,
      workspace,
      config,
    );
    const discovery = path.join(
      workspace.paths.cliHome,
      '.claude',
      'skills',
    );
    expect(await readFile(path.join(discovery, 'alpha', 'SKILL.md'), 'utf8')).toBe(
      'description-canary\nbody-canary-a',
    );
    expect(
      (await lstat(path.join(discovery, 'alpha', 'SKILL.md'))).mode &
        0o222,
    ).toBe(0);
    await chmod(path.join(discovery, 'alpha', 'SKILL.md'), 0o600);
    await writeFile(path.join(discovery, 'alpha', 'SKILL.md'), 'changed');
    expect(
      await readFile(path.join(sourceA, 'alpha', 'SKILL.md'), 'utf8'),
    ).toBe('description-canary\nbody-canary-a');
    await cleanupReplayWorkspace(workspace, config);
  });

  it('rejects merge collisions, limit overflow, and link escapes', async () => {
    const parent = await tempParent();
    const roots = [path.join(parent, 'a'), path.join(parent, 'b')];
    for (const root of roots) {
      await mkdir(root);
      await writeFile(path.join(root, 'SKILL.md'), 'same destination');
    }
    const config = normalizeRuntimeOptions({
      tempBase: parent,
      limits: { skillTotalBytes: 20, skillFileBytes: 20 },
    });
    const validated = validateAndBrandReplayBundle(sealedBundle());
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    await expect(
      exposeSkillSnapshots(
        roots.map((sourcePath, index) => ({
          id: `root-${index}`,
          sourcePath,
          scope: 'user' as const,
          precedence: index,
        })),
        CLAUDE_CODE_PROFILE,
        workspace,
        config,
      ),
    ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
    await cleanupReplayWorkspace(workspace, config);

    const linkRoot = path.join(parent, 'link-root');
    await mkdir(linkRoot);
    try {
      await symlink(
        path.join(parent, 'outside'),
        path.join(linkRoot, 'escape'),
        'dir',
      );
      const workspace2 = await createReplayWorkspace(
        config,
        validated,
        CLAUDE_CODE_PROFILE,
        () => {},
      );
      await expect(
        exposeSkillSnapshots(
          [
            {
              id: 'links',
              sourcePath: linkRoot,
              scope: 'project',
              precedence: 0,
            },
          ],
          CLAUDE_CODE_PROFILE,
          workspace2,
          config,
        ),
      ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
      await cleanupReplayWorkspace(workspace2, config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('rejects static junction/reparse roots and deterministic check/use path swaps', async () => {
    const parent = await tempParent();
    const outside = path.join(parent, 'outside');
    const source = path.join(parent, 'source');
    await mkdir(outside);
    await mkdir(source);
    await writeFile(path.join(outside, 'SKILL.md'), 'outside-canary');
    await symlink(
      outside,
      path.join(source, 'reparse'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const validated = validateAndBrandReplayBundle(sealedBundle());
    const firstWorkspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    await expect(
      exposeSkillSnapshots(
        [
          {
            id: 'static-reparse',
            sourcePath: source,
            scope: 'user',
            precedence: 0,
          },
        ],
        CLAUDE_CODE_PROFILE,
        firstWorkspace,
        config,
      ),
    ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
    await cleanupReplayWorkspace(firstWorkspace, config);

    await rm(path.join(source, 'reparse'), {
      recursive: true,
      force: true,
    });
    const selected = path.join(source, 'SKILL.md');
    const original = path.join(source, 'SKILL.original');
    await writeFile(selected, 'stable-bytes');
    const secondWorkspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    let swapped = false;
    await expect(
      exposeSkillSnapshots(
        [
          {
            id: 'swap',
            sourcePath: source,
            scope: 'project',
            precedence: 0,
          },
        ],
        CLAUDE_CODE_PROFILE,
        secondWorkspace,
        config,
        {
          async afterEntryValidated(sourcePath, kind) {
            if (!swapped && kind === 'file' && sourcePath === selected) {
              swapped = true;
              await rename(selected, original);
              await writeFile(selected, 'changed-byte');
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
    expect(swapped).toBe(true);
    await cleanupReplayWorkspace(secondWorkspace, config);

    await rm(selected);
    await rename(original, selected);
    const openedOriginal = path.join(source, 'SKILL.opened');
    const thirdWorkspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    let swappedAfterOpen = false;
    await expect(
      exposeSkillSnapshots(
        [
          {
            id: 'opened-swap',
            sourcePath: source,
            scope: 'project',
            precedence: 0,
          },
        ],
        CLAUDE_CODE_PROFILE,
        thirdWorkspace,
        config,
        {
          async afterFileOpened(sourcePath) {
            if (!swappedAfterOpen && sourcePath === selected) {
              swappedAfterOpen = true;
              await rename(selected, openedOriginal);
              await writeFile(selected, 'changed-byte');
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
    expect(swappedAfterOpen).toBe(true);
    await cleanupReplayWorkspace(thirdWorkspace, config);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects special files in a selected skill tree',
    async () => {
      const parent = await tempParent();
      const source = path.join(parent, 'special-root');
      const socketPath = path.join(source, 'skill.sock');
      await mkdir(source);
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      try {
        const config = normalizeRuntimeOptions({ tempBase: parent });
        const validated = validateAndBrandReplayBundle(sealedBundle());
        const workspace = await createReplayWorkspace(
          config,
          validated,
          CLAUDE_CODE_PROFILE,
          () => {},
        );
        await expect(
          exposeSkillSnapshots(
            [
              {
                id: 'special',
                sourcePath: source,
                scope: 'user',
                precedence: 0,
              },
            ],
            CLAUDE_CODE_PROFILE,
            workspace,
            config,
          ),
        ).rejects.toMatchObject({ code: 'skill-exposure-failed' });
        await cleanupReplayWorkspace(workspace, config);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe('workspace ownership transfer and cleanup failures', () => {
  it('retains cleanup authority across marker-write and partial-write failures', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const validated = validateAndBrandReplayBundle(sealedBundle());

    let markerOwnership: ReplayRootOwnership | null = null;
    await expect(
      createReplayWorkspace(
        config,
        validated,
        CLAUDE_CODE_PROFILE,
        (ownership) => {
          markerOwnership = ownership;
        },
        {
          beforeMarkerWrite() {
            throw new Error('marker write refused');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workspace-create-failed' });
    expect(markerOwnership).not.toBeNull();
    expect((await lstat(markerOwnership!.root)).isDirectory()).toBe(true);
    await cleanupReplayWorkspace(markerOwnership!, config);
    await expect(lstat(markerOwnership!.root)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    let partialOwnership: ReplayRootOwnership | null = null;
    await expect(
      createReplayWorkspace(
        config,
        validated,
        CLAUDE_CODE_PROFILE,
        (ownership) => {
          partialOwnership = ownership;
        },
        {
          beforeMaterializedWrite(kind) {
            if (kind === 'instruction') {
              throw new Error('instruction write refused');
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'instruction-stage-failed' });
    expect(partialOwnership).not.toBeNull();
    const partialEntries = await readFile(
      path.join(
        partialOwnership!.root,
        CLAUDE_CODE_PROFILE.storagePlan(validated).nativeFiles[0]!
          .relativePath,
      ),
    );
    expect(partialEntries.byteLength).toBeGreaterThan(0);
    await cleanupReplayWorkspace(partialOwnership!, config);
    await expect(lstat(partialOwnership!.root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never swallows replay-root deletion failure', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({ tempBase: parent });
    const validated = validateAndBrandReplayBundle(sealedBundle());
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    await expect(
      cleanupReplayWorkspace(workspace, config, {
        beforeRemoveRoot() {
          throw new Error('delete refused');
        },
      }),
    ).rejects.toMatchObject({
      code: 'cleanup-failed',
      stage: 'cleanup',
    });
    expect((await lstat(workspace.paths.root)).isDirectory()).toBe(true);
    await cleanupReplayWorkspace(workspace, config);
  });
});

describe('marker-scoped stale cleanup', () => {
  it('preserves unrelated directories in the dedicated namespace', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({
      tempBase: parent,
      limits: { staleRootAgeMs: 1 },
    });
    const unrelated = path.join(
      config.dedicatedTempBase,
      'replay-unrelated',
    );
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(unrelated, 'keep.txt'), 'keep');
    await cleanupStaleReplayRoots(config, Date.now() + 10_000);
    expect(await readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe(
      'keep',
    );
  });

  it('removes only an old marker-bearing replay root', async () => {
    const parent = await tempParent();
    const config = normalizeRuntimeOptions({
      tempBase: parent,
      limits: { staleRootAgeMs: 1 },
    });
    const validated = validateAndBrandReplayBundle(sealedBundle());
    const workspace = await createReplayWorkspace(
      config,
      validated,
      CLAUDE_CODE_PROFILE,
      () => {},
    );
    await cleanupStaleReplayRoots(config, Date.now() + 10_000);
    await expect(lstat(workspace.paths.root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
