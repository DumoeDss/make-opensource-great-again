/**
 * Direct filesystem probing for `~/.claude/projects/` legacy JSONL sessions.
 *
 * PROVENANCE: extracted VERBATIM from elftia
 * (`packages/desktop/app/main/services/routers/legacy/filesystem.ts`), MIT
 * relicensed into mosga under the initiator's copyright authorization
 * (planning-context.md, 2026-07-07). Pure Node FS; zero electron/DB coupling —
 * home is resolved via `os.homedir()` with `USERPROFILE`/`HOME` fallbacks.
 *
 * NOTE: `sanitizeProjectSlug` is currently unused by mosga (no caller in this
 * package). It is retained VERBATIM on purpose — this file is kept byte-for-byte
 * identical to upstream so a future elftia re-sync stays mechanical (design D5
 * risk note). Do not trim it without accepting that divergence.
 *
 * These helpers bypass `CodeFolderService.list()`'s metadata worker (10s
 * timeout, per-project JSONL parsing for cwd / first-5-sessions) which
 * stalls on machines with many `~/.claude/projects/` entries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { JsonlEntry } from './types.js';

/**
 * Direct directory scan — bypasses `CodeFolderService.list()`'s 10s metadata
 * worker (per-project JSONL parsing for cwd / first-5-sessions) which times
 * out on machines with many `~/.claude/projects/` entries.
 */
export function scanClaudeProjectDirs(): Array<{ slug: string; fullPath: string }> {
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
  const projectsRoot = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return [];
  const entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  const out: Array<{ slug: string; fullPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push({ slug: entry.name, fullPath: path.join(projectsRoot, entry.name) });
  }
  return out;
}

export const sanitizeProjectSlug = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  return value.replace(/[:\\/]/g, '-').replace(/_/g, '-');
};

/**
 * List session JSONL files at the top level of a project directory. Mirrors
 * `SdkRecordsMigrationRouter.scanJsonlFiles` — only `*.jsonl` directly under
 * the project dir count as importable sessions. UUID subdirectories (newer
 * subagent-style storage) are intentionally skipped.
 */
export function listSessionFilesInProject(projectDir: string): Array<{ id: string; filePath: string }> {
  if (!fs.existsSync(projectDir)) return [];
  const out: Array<{ id: string; filePath: string }> = [];
  const entries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        id: path.basename(e.name, '.jsonl'),
        filePath: path.join(projectDir, e.name),
      });
    }
  }
  return out;
}

/** Parse a JSONL file to JsonlEntry[]. Skips malformed lines silently. */
export function readSessionEntries(filePath: string): JsonlEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter((l) => l.trim());
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as JsonlEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/** Extract a summary string from JSONL entries (Claude Code stores one near the start). */
export function extractSummaryFromEntries(entries: JsonlEntry[]): string | null {
  for (const e of entries) {
    if (typeof e.summary === 'string' && e.summary.length > 0) return e.summary;
  }
  return null;
}

/**
 * Pull the real working directory out of a JSONL session.
 *
 * Claude Code CLI writes `cwd` on every entry — we just take the first
 * non-empty one. Falling back to the slugged `~/.claude/projects/<slug>`
 * directory would group sessions under a slug like
 * `C--cloudmusic-VipSongsDownload` instead of the actual project root,
 * which is what the user sees in the sidebar.
 */
export function extractCwdFromEntries(entries: JsonlEntry[]): string | null {
  for (const e of entries) {
    if (typeof e.cwd === 'string' && e.cwd.length > 0) return e.cwd;
  }
  return null;
}

/**
 * Cheaply probe the cwd of a `~/.claude/projects/<slug>/` folder by
 * peeking at the first JSONL's `cwd` field. Claude Code CLI uses one
 * folder per cwd (the slug encodes the cwd), so any single JSONL is
 * representative — we don't need to read every file.
 *
 * Returns `null` if the folder has no JSONL, the file can't be read,
 * or no entry carries a `cwd` field.
 */
export function probeProjectCwd(projectDir: string): string | null {
  const files = listSessionFilesInProject(projectDir);
  const firstFile = files[0];
  if (!firstFile) return null;
  // Read just enough lines to find the first `cwd`. Bail after ~50
  // lines so a malformed multi-MB JSONL doesn't block the scan.
  const filePath = firstFile.filePath;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  const ceiling = Math.min(lines.length, 50);
  for (let i = 0; i < ceiling; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // skip malformed line
    }
  }
  return null;
}
