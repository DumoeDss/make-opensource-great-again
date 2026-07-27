import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { FilePublicationTargetStore } from '../publication/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const VITEST = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WORKER = path.join(
  REPO_ROOT,
  'packages',
  'daemon',
  'src',
  '__tests__',
  'publication-lock-worker.test.ts',
);
const roots: string[] = [];
const children = new Set<ChildProcess>();

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosga-lock-process-'));
  roots.push(root);
  return root;
}

function marker(root: string, id: string, name: string): string {
  return path.join(root, `${id}.${name}`);
}

function signal(root: string, id: string, name: string): void {
  fs.writeFileSync(marker(root, id, name), '', 'utf8');
}

async function waitFor(
  filePath: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startWorker(
  root: string,
  role: string,
  id: string,
): { child: ChildProcess; done: Promise<void>; output: () => string } {
  let captured = '';
  const child = spawn(
    process.execPath,
    [
      VITEST,
      'run',
      WORKER,
      '--config',
      path.join(REPO_ROOT, 'vitest.config.ts'),
      '--maxWorkers=1',
      '--reporter=dot',
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MOSGA_LOCK_WORKER_ROLE: role,
        MOSGA_LOCK_WORKER_ROOT: root,
        MOSGA_LOCK_WORKER_ID: id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  child.stdout?.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    captured += chunk.toString('utf8');
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signalName) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`worker ${id} exited ${code}/${signalName}\n${captured}`));
    });
  });
  return { child, done, output: () => captured };
}

afterEach(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 20));
  children.clear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-process publication lock protocol', () => {
  it(
    'cannot ABA-delete a replacement claim after two processes observe the same stale owner',
    async () => {
      const root = tempRoot();
      const lockDirectory = path.join(root, 'aba.lock');
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(
        path.join(lockDirectory, 'stale-owner.claim'),
        `${JSON.stringify({
          schemaVersion: 1,
          pid: 2_147_483_647,
          token: 'stale-owner',
        })}\n`,
        'utf8',
      );

      const a = startWorker(root, 'claim-race', 'a');
      const b = startWorker(root, 'claim-race', 'b');
      await Promise.all([
        waitFor(marker(root, 'a', 'observed')),
        waitFor(marker(root, 'b', 'observed')),
      ]);

      signal(root, 'b', 'go');
      await waitFor(marker(root, 'b', 'acquired'));
      signal(root, 'a', 'go');
      await waitFor(marker(root, 'a', 'busy'));

      const third = startWorker(root, 'claim-attempt', 'third');
      await third.done;
      expect(fs.existsSync(marker(root, 'third', 'busy'))).toBe(true);
      expect(fs.existsSync(marker(root, 'third', 'acquired'))).toBe(false);

      signal(root, 'b', 'release');
      await Promise.all([a.done, b.done]);
      expect(fs.readdirSync(lockDirectory)).toEqual([]);
    },
    70_000,
  );

  it(
    'does not double-hold FilePublicationLock and recovers after its owner process exits',
    async () => {
      const root = tempRoot();
      const holder = startWorker(root, 'publication-hold', 'holder');
      await waitFor(marker(root, 'holder', 'acquired'));

      const contender = startWorker(root, 'publication-attempt', 'contender');
      await contender.done;
      expect(fs.existsSync(marker(root, 'contender', 'busy'))).toBe(true);
      expect(fs.existsSync(marker(root, 'contender', 'acquired'))).toBe(false);

      holder.child.kill();
      await holder.done.catch(() => undefined);
      const recovery = startWorker(root, 'publication-attempt', 'recovery');
      await recovery.done;
      expect(fs.existsSync(marker(root, 'recovery', 'acquired'))).toBe(true);
      expect(fs.readdirSync(path.join(root, 'publication.lock'))).toEqual([]);
    },
    70_000,
  );

  it(
    'serializes target mutations across real processes without reusing a revision',
    async () => {
      const root = tempRoot();
      const workers = ['one', 'two', 'three'].map((id) =>
        startWorker(root, 'target-configure', id),
      );
      await Promise.all(
        ['one', 'two', 'three'].map((id) =>
          waitFor(marker(root, id, 'ready')),
        ),
      );
      for (const id of ['one', 'two', 'three']) signal(root, id, 'go');
      await Promise.all(workers.map((worker) => worker.done));

      const revisions = ['one', 'two', 'three']
        .map((id) =>
          JSON.parse(fs.readFileSync(marker(root, id, 'result'), 'utf8')) as {
            revision: number;
          },
        )
        .map((value) => value.revision)
        .sort((a, b) => a - b);
      expect(revisions).toEqual([1, 2, 3]);
      expect(
        (await new FilePublicationTargetStore(path.join(root, 'target.json')).read())
          .revision,
      ).toBe(3);
      expect(fs.readdirSync(path.join(root, 'target.json.lock'))).toEqual([]);
    },
    70_000,
  );
});
