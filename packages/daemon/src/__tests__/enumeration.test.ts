import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  makeTempDir,
  plainTurn,
  rm,
  secretTurn,
  withServer,
  writeGitRemote,
  writeSession,
} from './_helpers.js';

describe('enumeration + whitelist routes', () => {
  let home: string;
  let cwdPublic: string;
  let cwdPrivate: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwdPublic = makeTempDir('mosga-cwd-pub-');
    cwdPrivate = makeTempDir('mosga-cwd-priv-');
    // Project A: cwd has a public git remote → recommended.
    writeGitRemote(cwdPublic, 'https://github.com/octocat/hello-world.git');
    writeSession(home, 'projA', 'sess-a', cwdPublic, [plainTurn('a1')]);
    // Project B: cwd has no git remote → not recommended.
    writeSession(home, 'projB', 'sess-b', cwdPrivate, [secretTurn('b1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwdPublic);
    rm(cwdPrivate);
  });

  it('lists sources including claude-code', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const res = await fetch(`${base}/api/sources`);
      const body = (await res.json()) as { sources: Array<{ id: string; displayName: string }> };
      expect(body.sources.some((s) => s.id === 'claude-code')).toBe(true);
    });
  });

  it('annotates projects recommended/not by git remote and filters by default', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const all = (await (await fetch(`${base}/api/sources/claude-code/projects?all=1`)).json()) as {
        projects: Array<{ key: string; recommended: boolean; gitRemote: string | null }>;
        totalCount: number;
        recommendedCount: number;
      };
      expect(all.totalCount).toBe(2);
      expect(all.recommendedCount).toBe(1);
      const a = all.projects.find((p) => p.key === 'projA');
      const b = all.projects.find((p) => p.key === 'projB');
      expect(a?.recommended).toBe(true);
      expect(a?.gitRemote).toContain('github.com');
      expect(b?.recommended).toBe(false);
      expect(b?.gitRemote).toBeNull();

      // Default (recommended-only) hides projB.
      const rec = (await (await fetch(`${base}/api/sources/claude-code/projects`)).json()) as {
        projects: Array<{ key: string }>;
      };
      expect(rec.projects.map((p) => p.key)).toEqual(['projA']);
    });
  });

  it('enumerates sessions for a project', async () => {
    await withServer({ homeDir: home }, async (base) => {
      const res = await fetch(`${base}/api/sources/claude-code/projects/projA/sessions`);
      const body = (await res.json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((s) => s.id)).toEqual(['sess-a']);
    });
  });

  it('does not throw on an unknown source or project', async () => {
    await withServer({ homeDir: home }, async (base) => {
      expect((await fetch(`${base}/api/sources/nope/projects`)).status).toBe(404);
      expect(
        (await fetch(`${base}/api/sources/claude-code/projects/missing/sessions`)).status,
      ).toBe(404);
    });
  });
});
