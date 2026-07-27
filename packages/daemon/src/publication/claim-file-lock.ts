import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ClaimRecord {
  schemaVersion: 1;
  pid: number;
  token: string;
}

export interface ClaimFileLockHooks {
  /**
   * Test-only synchronization point. Production callers do not provide hooks.
   * The claim pathname is acquisition-specific and is never reused.
   */
  beforeReclaim?: (claimPath: string, claim: ClaimRecord) => Promise<void>;
}

export interface ClaimFileLockOptions {
  maxAttempts: number;
  retryMs: number;
  busy(): never;
  unavailable(): never;
  hooks?: ClaimFileLockHooks;
}

const CLAIM_SUFFIX = '.claim';

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and platform-specific probe failures are treated as live. PID reuse
    // can therefore delay recovery, but it can never cause a live claim to be
    // reclaimed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseClaim(contents: string, expectedToken: string): ClaimRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
    (value as { pid: number }).pid < 1 ||
    (value as { token?: unknown }).token !== expectedToken ||
    Object.keys(value).some(
      (key) => key !== 'schemaVersion' && key !== 'pid' && key !== 'token',
    )
  ) {
    return null;
  }
  return value as ClaimRecord;
}

async function inspectClaims(
  lockDirectory: string,
  ownToken: string | undefined,
  options: ClaimFileLockOptions,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(lockDirectory);
  } catch {
    return options.unavailable();
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(CLAIM_SUFFIX)) continue;
    const token = entry.slice(0, -CLAIM_SUFFIX.length);
    if (token === ownToken) continue;
    const claimPath = path.join(lockDirectory, entry);
    let contents: string | undefined;
    for (let readAttempt = 0; readAttempt < 3; readAttempt += 1) {
      try {
        contents = await fs.promises.readFile(claimPath, 'utf8');
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') break;
        if (
          readAttempt < 2 &&
          (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM')
        ) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 2);
          });
          continue;
        }
        // A claim owner may release its unique pathname after readdir but
        // before Windows grants our read. If it is now gone, that is the same
        // harmless race as ENOENT; an extant unreadable claim fails closed.
        try {
          await fs.promises.lstat(claimPath);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') break;
        }
        return options.unavailable();
      }
    }
    if (contents === undefined) continue;
    const claim = parseClaim(contents, token);
    if (!claim) return options.unavailable();
    if (processIsAlive(claim.pid)) {
      return true;
    }

    await options.hooks?.beforeReclaim?.(claimPath, claim);
    try {
      await fs.promises.unlink(claimPath);
    } catch (error) {
      // Another reclaimer may have removed this exact, never-reused UUID
      // claim. ENOENT is success; importantly, no shared pathname is unlinked.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return options.unavailable();
      }
    }
  }
  return false;
}

async function publishClaim(
  lockDirectory: string,
  token: string,
  options: ClaimFileLockOptions,
): Promise<string> {
  const claimPath = path.join(lockDirectory, `${token}${CLAIM_SUFFIX}`);
  const temporary = `${lockDirectory}.${token}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    const claim: ClaimRecord = { schemaVersion: 1, pid: process.pid, token };
    await handle.writeFile(`${JSON.stringify(claim)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The claim becomes visible only after its complete contents are durable.
    // Its UUID pathname is unique to this acquisition and is never reused.
    await fs.promises.rename(temporary, claimPath);
    return claimPath;
  } catch {
    await handle?.close().catch(() => undefined);
    await fs.promises.unlink(temporary).catch(() => undefined);
    return options.unavailable();
  }
}

/**
 * Cross-process claim lock with acquisition-specific identity.
 *
 * A persistent directory contains one immutable UUID claim per contender.
 * Reclamation deletes only a dead contender's UUID pathname; a later
 * acquisition always uses a different pathname, eliminating the shared-name
 * read/check/unlink ABA. After publishing its claim, a contender scans again.
 * Filesystem operation ordering means either it observes every earlier live
 * claim and withdraws, or a later contender observes it and withdraws.
 */
export async function acquireClaimFileLock(
  lockDirectory: string,
  options: ClaimFileLockOptions,
): Promise<() => Promise<void>> {
  if (
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    !Number.isSafeInteger(options.retryMs) ||
    options.retryMs < 0
  ) {
    return options.unavailable();
  }
  try {
    await fs.promises.mkdir(path.dirname(lockDirectory), { recursive: true });
    await fs.promises.mkdir(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return options.unavailable();
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(lockDirectory);
    } catch {
      return options.unavailable();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return options.unavailable();
    }
  }

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (!(await inspectClaims(lockDirectory, undefined, options))) {
      const token = randomUUID();
      const claimPath = await publishClaim(lockDirectory, token, options);
      let collides = true;
      try {
        collides = await inspectClaims(lockDirectory, token, options);
      } catch (error) {
        await fs.promises.unlink(claimPath).catch(() => undefined);
        throw error;
      }
      if (!collides) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await fs.promises.unlink(claimPath).catch(() => undefined);
        };
      }
      await fs.promises.unlink(claimPath).catch(() => undefined);
    }

    if (attempt + 1 < options.maxAttempts) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, options.retryMs);
      });
    }
  }
  return options.busy();
}
