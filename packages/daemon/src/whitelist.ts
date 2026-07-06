/**
 * Git-remote whitelist recommendation (design D4) — the design doc's first
 * "专有代码不泄漏" defense, surfaced to the picker.
 *
 * This is a RECOMMENDATION biasing the picker, NOT enforcement. The heuristic:
 * walk up from the project `cwd` to find a `.git/config`, read its first remote
 * url, and mark the project `recommended` when that url points to a recognized
 * public host. Its blind spots are real and intentional to document: a private
 * mirror hosted on a public host is misclassified `recommended`, and an unpushed
 * repo (no remote) is misclassified not-recommended. The real defenses are the
 * scan and the human gate; "show all" is always available.
 *
 * Reading `.git/config` (rather than shelling out to `git`) keeps this pure,
 * dependency-free, cross-platform, and deterministic for tests.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CliProjectRef } from '@mosga/contracts';

/** Hosts we treat as public code-hosting for the recommendation. */
const PUBLIC_GIT_HOSTS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'sr.ht',
  'sourceforge.net',
];

/** How many parent directories to climb looking for a `.git` dir. */
const MAX_GIT_WALK_UP = 6;

export interface ProjectAnnotation extends CliProjectRef {
  gitRemote: string | null;
  recommended: boolean;
  recommendReason: string;
}

/** Find the nearest `.git/config` at or above `dir`, or null. */
function findGitConfig(dir: string): string | null {
  let current = path.resolve(dir);
  for (let i = 0; i < MAX_GIT_WALK_UP; i += 1) {
    const configPath = path.join(current, '.git', 'config');
    if (fs.existsSync(configPath)) return configPath;
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return null;
}

/** Read the first `url = ...` under any `[remote ...]` section of a git config. */
export function readFirstRemoteUrl(configPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  let inRemote = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inRemote = /^\[remote\b/.test(line);
      continue;
    }
    if (inRemote) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/** Extract a comparable host from an scp-like or URL git remote. */
export function remoteHost(remote: string): string | null {
  // scp-like: git@github.com:owner/repo.git
  const scp = /^[^@]+@([^:]+):/.exec(remote);
  if (scp) return scp[1].toLowerCase();
  // url form: https://github.com/owner/repo.git, ssh://git@host/...
  try {
    const url = new URL(remote);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isPublicHost(host: string): boolean {
  return PUBLIC_GIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Probe a project's cwd for a git remote and derive the recommendation. */
export function annotateProject(project: CliProjectRef): ProjectAnnotation {
  if (!project.cwd) {
    return {
      ...project,
      gitRemote: null,
      recommended: false,
      recommendReason: 'no working directory to probe for a git remote',
    };
  }
  const configPath = findGitConfig(project.cwd);
  if (!configPath) {
    return {
      ...project,
      gitRemote: null,
      recommended: false,
      recommendReason: 'no .git/config found at or above the working directory',
    };
  }
  const remote = readFirstRemoteUrl(configPath);
  if (!remote) {
    return {
      ...project,
      gitRemote: null,
      recommended: false,
      recommendReason: 'git repository has no configured remote',
    };
  }
  const host = remoteHost(remote);
  if (host && isPublicHost(host)) {
    return {
      ...project,
      gitRemote: remote,
      recommended: true,
      recommendReason: `git remote on recognized public host ${host}`,
    };
  }
  return {
    ...project,
    gitRemote: remote,
    recommended: false,
    recommendReason: host
      ? `git remote host ${host} is not a recognized public host`
      : 'git remote url could not be parsed for a host',
  };
}
