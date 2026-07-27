import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { acquireClaimFileLock } from '../publication/claim-file-lock.js';
import {
  FilePublicationLock,
  FilePublicationTargetStore,
} from '../publication/index.js';

const role = process.env.MOSGA_LOCK_WORKER_ROLE;
const root = process.env.MOSGA_LOCK_WORKER_ROOT;
const workerId = process.env.MOSGA_LOCK_WORKER_ID ?? role ?? 'worker';

function marker(name: string): string {
  if (!root) throw new Error('worker root missing');
  return path.join(root, `${workerId}.${name}`);
}

function writeMarker(name: string, contents = ''): void {
  fs.writeFileSync(marker(name), contents, 'utf8');
}

async function waitFor(name: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(marker(name))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function claimRace(): Promise<void> {
  if (!root) throw new Error('worker root missing');
  const lockDirectory = path.join(root, 'aba.lock');
  let observed = false;
  try {
    const release = await acquireClaimFileLock(lockDirectory, {
      maxAttempts: 1,
      retryMs: 0,
      busy: () => {
        throw new Error('BUSY');
      },
      unavailable: () => {
        throw new Error('UNAVAILABLE');
      },
      hooks: {
        beforeReclaim: async (_claimPath, claim) => {
          if (claim.token !== 'stale-owner') return;
          observed = true;
          writeMarker('observed');
          await waitFor('go');
        },
      },
    });
    if (!observed) throw new Error('stale claim was not observed');
    writeMarker('acquired');
    await waitFor('release');
    await release();
    writeMarker('released');
  } catch (error) {
    if ((error as Error).message !== 'BUSY') throw error;
    writeMarker('busy');
  }
}

async function claimAttempt(): Promise<void> {
  if (!root) throw new Error('worker root missing');
  try {
    const release = await acquireClaimFileLock(path.join(root, 'aba.lock'), {
      maxAttempts: 1,
      retryMs: 0,
      busy: () => {
        throw new Error('BUSY');
      },
      unavailable: () => {
        throw new Error('UNAVAILABLE');
      },
    });
    writeMarker('acquired');
    await release();
  } catch (error) {
    if ((error as Error).message !== 'BUSY') throw error;
    writeMarker('busy');
  }
}

async function publicationHold(): Promise<void> {
  if (!root) throw new Error('worker root missing');
  const lock = new FilePublicationLock(path.join(root, 'publication.lock'));
  await lock.run(async () => {
    writeMarker('acquired');
    await waitFor('release', 60_000);
  });
  writeMarker('released');
}

async function publicationAttempt(): Promise<void> {
  if (!root) throw new Error('worker root missing');
  const lock = new FilePublicationLock(path.join(root, 'publication.lock'));
  try {
    await lock.run(async () => {
      writeMarker('acquired');
    });
  } catch (error) {
    if (
      (error as { body?: { code?: string } }).body?.code !==
      'publish_in_flight'
    ) {
      throw error;
    }
    writeMarker('busy');
  }
}

async function targetConfigure(): Promise<void> {
  if (!root) throw new Error('worker root missing');
  writeMarker('ready');
  await waitFor('go');
  const target = new FilePublicationTargetStore(path.join(root, 'target.json'));
  const result = await target.configure({
    owner: `owner-${workerId}`,
    repo: 'dataset',
  });
  writeMarker('result', JSON.stringify(result));
}

describe.skipIf(!role || !root)('cross-process publication lock worker', () => {
  it(
    `runs ${role ?? 'no-op'}`,
    async () => {
      switch (role) {
        case 'claim-race':
          await claimRace();
          break;
        case 'claim-attempt':
          await claimAttempt();
          break;
        case 'publication-hold':
          await publicationHold();
          break;
        case 'publication-attempt':
          await publicationAttempt();
          break;
        case 'target-configure':
          await targetConfigure();
          break;
        default:
          throw new Error(`unknown worker role: ${role}`);
      }
      expect(true).toBe(true);
    },
    70_000,
  );
});
