/**
 * codex source adapter.
 *
 * PROVENANCE: adapted from elftia's `codexAdapter.ts`
 * (`packages/desktop/app/main/services/capabilities/code-cli/sources/adapters/codexAdapter.ts`,
 * MIT reuse under the initiator's authorization). Re-pointed at
 * `@mosga/contracts`; elftia's GUI/native-resume surface (`registryBackendId`,
 * `resolveTranscriptPathById`, `read`) is dropped — mosga's leaner
 * `CliSourceAdapter` keeps only enumeration + metadata + a clean parse delegate.
 *
 * Codex organizes rollouts by DATE, not project:
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ts>-<uuid>.jsonl[.zst]`. A
 * single bounded date-tree walk produces both the project grouping (distinct
 * `session_meta.cwd`) and the per-session refs — both `listProjects` and
 * `listSessions` filter the shared `scanCodexRollouts()` result. Each rollout's
 * first `session_meta` line (id/cwd) + first real user `input_text` (title) are
 * read ONCE from a bounded prefix. Transcript parsing is delegated to
 * `parseCodexSession`. Pure FS read-only — never throws on a missing/unreadable
 * tree or file (returns what it can).
 *
 * `.jsonl.zst` policy (design D2): compressed rollouts are recognized so the
 * walk stays complete, but NOT enumerated as sessions (and the parser returns
 * `[]` for a `.zst` path) — no zstd dependency this slice.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CliProjectRef, CliSessionRef, ParsedMessage } from '@mosga/contracts';

import { parseCodexSession } from '../parseCodexSession.js';
import type { CliSourceAdapter } from './types.js';

const SOURCE_ID = 'codex';
/** Synthetic project key for rollouts with no decodable cwd. */
const UNKNOWN_PROJECT_KEY = '(unknown)';
const MAX_TITLE_LEN = 120;
const MAX_WALK_DEPTH = 8;
/** Bounded prefix read — session_meta is line 1; the first user turn sits just past it. */
const PREFIX_BYTES = 128 * 1024;
const PREFIX_LINES = 60;

/** Codex-injected system scaffolding `user` turns to skip when picking a title. */
const SCAFFOLDING_PREFIXES = ['<environment_context>', '<user_instructions>'];

/** Collapse whitespace + truncate (with an ellipsis) to a sidebar-friendly title. */
function truncateTitle(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_TITLE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
}

function isScaffolding(text: string): boolean {
  const trimmed = text.trimStart();
  return SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Join `input_text` parts of a codex `message.content` array. */
function joinInputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p && p.type === 'input_text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

interface CodexSessionMeta {
  id: string | null;
  cwd: string | null;
  title: string | null;
}

/**
 * Pure metadata extractor: read the `session_meta` line (id/cwd) + the first
 * real user `input_text` (skipping `<environment_context>`/`<user_instructions>`
 * scaffolding) for the title. Exported for unit tests (parallels
 * `extractClaudeTitle`).
 */
export function parseCodexSessionMeta(firstLines: string[]): CodexSessionMeta {
  let id: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;

  for (const raw of firstLines) {
    const text = raw.trim();
    if (!text) continue;
    let line: { type?: string; payload?: Record<string, unknown> };
    try {
      line = JSON.parse(text) as typeof line;
    } catch {
      continue; // skip malformed line
    }
    const payload = line.payload ?? {};

    if (line.type === 'session_meta') {
      if (typeof payload.id === 'string') id = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd.length > 0) cwd = payload.cwd;
      continue;
    }
    if (
      title === null &&
      line.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user'
    ) {
      const candidate = joinInputText(payload.content);
      if (candidate && !isScaffolding(candidate)) title = truncateTitle(candidate);
    }
  }
  return { id, cwd, title };
}

/** `.jsonl` / `.jsonl.zst` rollout-file recognition. */
function rolloutExt(name: string): '.jsonl' | '.jsonl.zst' | null {
  if (name.endsWith('.jsonl.zst')) return '.jsonl.zst';
  if (name.endsWith('.jsonl')) return '.jsonl';
  return null;
}

function isRolloutFile(name: string): boolean {
  return name.startsWith('rollout-') && rolloutExt(name) !== null;
}

const TRAILING_UUID_RE =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Fallback id: the trailing UUID in `rollout-<ts>-<uuid>.jsonl[.zst]`. */
function uuidFromRolloutName(name: string): string | null {
  const ext = rolloutExt(name);
  if (!ext) return null;
  const match = TRAILING_UUID_RE.exec(name.slice(0, -ext.length));
  return match ? match[1] : null;
}

/** Read a bounded prefix of a file as UTF-8 lines (never throws). */
function readPrefixLines(filePath: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(PREFIX_BYTES);
    const bytes = fs.readSync(fd, buf, 0, PREFIX_BYTES, 0);
    const lines = buf.toString('utf-8', 0, bytes).split('\n');
    // Drop a partial final line when the file was longer than the prefix.
    if (bytes >= PREFIX_BYTES && lines.length > 1) lines.pop();
    return lines.slice(0, PREFIX_LINES);
  } catch {
    return [];
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

interface RolloutScan {
  path: string;
  meta: CodexSessionMeta;
}

function scanRolloutFile(filePath: string): RolloutScan {
  const name = path.basename(filePath);
  const meta = parseCodexSessionMeta(readPrefixLines(filePath));
  const fallbackId = uuidFromRolloutName(name);
  return { path: filePath, meta: { id: meta.id ?? fallbackId, cwd: meta.cwd, title: meta.title } };
}

/**
 * Bounded, pure-FS date-tree walk. Recognizes `rollout-*-<uuid>.jsonl[.zst]`
 * files but enumerates only `.jsonl` (D2: `.jsonl.zst` is recognized so the
 * walk is complete, but not listed as a session). Never throws.
 */
function walkRollouts(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable dir → degrade cleanly
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && isRolloutFile(entry.name)) {
      // Skip `.jsonl.zst` at enumeration — recognized but not decompressed (D2).
      if (rolloutExt(entry.name) === '.jsonl') out.push(full);
    } else if (entry.isDirectory()) {
      walkRollouts(full, depth + 1, out);
    }
  }
}

function scanCodexRollouts(roots: string[]): RolloutScan[] {
  const files: string[] = [];
  for (const root of roots) walkRollouts(root, 0, files);
  return files.map(scanRolloutFile);
}

/** Normalize a scanned cwd to a non-empty string or null. */
function normalizeCwd(cwd: string | null): string | null {
  return cwd && cwd.length > 0 ? cwd : null;
}

export const codexAdapter: CliSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Codex',

  locateRoots(home: string): string[] {
    return [path.join(home, '.codex', 'sessions')];
  },

  listProjects(roots: string[]): CliProjectRef[] {
    const byKey = new Map<string, CliProjectRef>();
    for (const { meta } of scanCodexRollouts(roots)) {
      const cwd = normalizeCwd(meta.cwd);
      const key = cwd ?? UNKNOWN_PROJECT_KEY;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        sourceId: SOURCE_ID,
        key,
        cwd,
        label: cwd ? path.basename(cwd) : UNKNOWN_PROJECT_KEY,
      });
    }
    return [...byKey.values()];
  },

  countSessionsByProject(roots: string[]): Record<string, number> {
    // One rollout scan (the same pass listProjects pays), grouped into counts.
    const counts: Record<string, number> = {};
    for (const { meta } of scanCodexRollouts(roots)) {
      const key = normalizeCwd(meta.cwd) ?? UNKNOWN_PROJECT_KEY;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  },

  listSessions(roots: string[], project: CliProjectRef): CliSessionRef[] {
    const out: CliSessionRef[] = [];
    for (const { path: rolloutPath, meta } of scanCodexRollouts(roots)) {
      const cwd = normalizeCwd(meta.cwd);
      const key = cwd ?? UNKNOWN_PROJECT_KEY;
      if (key !== project.key) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(rolloutPath);
      } catch {
        continue;
      }
      out.push({
        sourceId: SOURCE_ID,
        projectKey: project.key,
        id: meta.id ?? path.basename(rolloutPath),
        path: rolloutPath,
        title: meta.title,
        cwd,
        updatedAt: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
    return out;
  },

  resolveTranscriptPath(ref: CliSessionRef): string {
    return ref.path;
  },

  parseTranscriptToMessages(transcriptPath: string): ParsedMessage[] {
    return parseCodexSession(transcriptPath);
  },
};
