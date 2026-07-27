import { randomUUID } from 'node:crypto';
import fs, { type promises as fsPromises } from 'node:fs';
import path from 'node:path';

import {
  PublicationError,
  type StoredPublicationTarget,
} from './types.js';
import { acquireClaimFileLock } from './claim-file-lock.js';
import { parseCanonicalRepository } from './target.js';

export interface PublicationTargetStore {
  read(): Promise<StoredPublicationTarget>;
  configure(upstream: { owner: string; repo: string }): Promise<StoredPublicationTarget>;
  clear(): Promise<StoredPublicationTarget>;
}

export interface TargetFileSystem {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string, options: { encoding: BufferEncoding; flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const INITIAL: StoredPublicationTarget = {
  schemaVersion: 1,
  revision: 0,
  upstream: null,
};

const ACTIVE_TARGET_MUTATIONS = new Map<string, Promise<void>>();
const TARGET_LOCK_ATTEMPTS = 250;
const TARGET_LOCK_RETRY_MS = 20;

function unavailable(): never {
  throw new PublicationError({
    code: 'target_store_unavailable',
    phase: 'target',
    message: 'Publication target configuration is unavailable.',
    retryable: true,
    recovery: 'Retry or restart the daemon after checking local application storage.',
  });
}

export function parseStoredPublicationTarget(raw: unknown): StoredPublicationTarget {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Number.isSafeInteger((raw as { revision?: unknown }).revision) ||
    ((raw as { revision: number }).revision < 0)
  ) {
    return unavailable();
  }
  const upstream = (raw as { upstream?: unknown }).upstream;
  if (
    upstream !== null &&
    (typeof upstream !== 'object' ||
      upstream === null ||
      typeof (upstream as { owner?: unknown }).owner !== 'string' ||
      typeof (upstream as { repo?: unknown }).repo !== 'string' ||
      Object.keys(upstream).some((key) => key !== 'owner' && key !== 'repo'))
  ) {
    return unavailable();
  }
  if (Object.keys(raw).some((key) => !['schemaVersion', 'revision', 'upstream'].includes(key))) {
    return unavailable();
  }
  if (upstream !== null) {
    try {
      parseCanonicalRepository(
        `${(upstream as { owner: string }).owner}/${(upstream as { repo: string }).repo}`,
      );
    } catch {
      return unavailable();
    }
  }
  return {
    schemaVersion: 1,
    revision: (raw as { revision: number }).revision,
    upstream: upstream as StoredPublicationTarget['upstream'],
  };
}

export class InMemoryPublicationTargetStore implements PublicationTargetStore {
  private state: StoredPublicationTarget;

  constructor(initial: StoredPublicationTarget = INITIAL) {
    this.state = parseStoredPublicationTarget(structuredClone(initial));
  }

  async read(): Promise<StoredPublicationTarget> {
    return structuredClone(this.state);
  }

  async configure(upstream: { owner: string; repo: string }): Promise<StoredPublicationTarget> {
    if (
      this.state.upstream?.owner === upstream.owner &&
      this.state.upstream.repo === upstream.repo
    ) {
      return this.read();
    }
    this.state = {
      schemaVersion: 1,
      revision: this.state.revision + 1,
      upstream: { ...upstream },
    };
    return this.read();
  }

  async clear(): Promise<StoredPublicationTarget> {
    if (this.state.upstream === null) return this.read();
    this.state = {
      schemaVersion: 1,
      revision: this.state.revision + 1,
      upstream: null,
    };
    return this.read();
  }
}

export class FilePublicationTargetStore implements PublicationTargetStore {
  private readonly filePath: string;
  private readonly io: TargetFileSystem;

  constructor(
    filePath: string,
    io: TargetFileSystem = fs.promises as unknown as TargetFileSystem,
  ) {
    this.filePath = filePath;
    this.io = io;
  }

  async read(): Promise<StoredPublicationTarget> {
    let contents: string;
    try {
      contents = await this.io.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(INITIAL);
      return unavailable();
    }
    try {
      return parseStoredPublicationTarget(JSON.parse(contents) as unknown);
    } catch (error) {
      if (error instanceof PublicationError) throw error;
      return unavailable();
    }
  }

  async configure(upstream: { owner: string; repo: string }): Promise<StoredPublicationTarget> {
    return this.mutate(async () => {
      const current = await this.read();
      if (
        current.upstream?.owner === upstream.owner &&
        current.upstream.repo === upstream.repo
      ) {
        return current;
      }
      return this.write({
        schemaVersion: 1,
        revision: current.revision + 1,
        upstream: { ...upstream },
      });
    });
  }

  async clear(): Promise<StoredPublicationTarget> {
    return this.mutate(async () => {
      const current = await this.read();
      if (current.upstream === null) return current;
      return this.write({
        schemaVersion: 1,
        revision: current.revision + 1,
        upstream: null,
      });
    });
  }

  private async mutate(
    action: () => Promise<StoredPublicationTarget>,
  ): Promise<StoredPublicationTarget> {
    const lockKey = path.resolve(`${this.filePath}.lock`);
    const predecessor = ACTIVE_TARGET_MUTATIONS.get(lockKey) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => queued);
    ACTIVE_TARGET_MUTATIONS.set(lockKey, tail);
    await predecessor.catch(() => undefined);

    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      releaseFileLock = await acquireTargetFileLock(lockKey);
      // The read is deliberately inside both locks. Every successful mutation
      // therefore consumes the latest durable revision exactly once.
      return await action();
    } finally {
      await releaseFileLock?.();
      releaseQueue();
      if (ACTIVE_TARGET_MUTATIONS.get(lockKey) === tail) {
        ACTIVE_TARGET_MUTATIONS.delete(lockKey);
      }
    }
  }

  private async write(next: StoredPublicationTarget): Promise<StoredPublicationTarget> {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await this.io.mkdir(directory, { recursive: true });
      await this.io.writeFile(temporary, `${JSON.stringify(next)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await this.io.rename(temporary, this.filePath);
      return structuredClone(next);
    } catch {
      try {
        await this.io.unlink(temporary);
      } catch {
        // Best-effort cleanup; the stable public error never includes the path.
      }
      return unavailable();
    }
  }
}

async function acquireTargetFileLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  return acquireClaimFileLock(lockPath, {
    maxAttempts: TARGET_LOCK_ATTEMPTS,
    retryMs: TARGET_LOCK_RETRY_MS,
    busy: unavailable,
    unavailable,
  });
}
