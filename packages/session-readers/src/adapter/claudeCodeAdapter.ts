/**
 * claude-code source adapter.
 *
 * Reshaped from elftia's `claudeCodeAdapter.ts` (design D4): enumerates
 * `~/.claude/projects/<slug>/` (one dir per project) and each project's
 * top-level `<id>.jsonl` sessions, composing the extracted
 * `filesystem.ts` primitives. Transcript parsing is delegated to
 * `parseClaudeSession` (the non-text-marker wrapper), NOT elftia's display-IR
 * reader. Pure FS read-only — never throws on a missing/unreadable dir or file
 * (returns what it can). v0.1 ships ONLY this adapter.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CliProjectRef, CliSessionRef, ParsedMessage } from '@mosga/contracts';

import {
  extractSummaryFromEntries,
  listSessionFilesInProject,
  probeProjectCwd,
  readSessionEntries,
} from '../filesystem.js';
import { parseClaudeSession } from '../parseClaudeSession.js';
import type { ContentBlock, JsonlEntry } from '../types.js';
import type { CliSourceAdapter } from './types.js';

const SOURCE_ID = 'claude-code';
const MAX_TITLE_LEN = 120;

/** Collapse whitespace + truncate (with an ellipsis) to a sidebar-friendly title. */
function truncateTitle(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_TITLE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
}

/** Flatten a JSONL `message.content` (string or text blocks) to plain text. */
function contentToText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** First real `user` text turn (skipping meta/system rows), or null. */
function firstUserText(entries: JsonlEntry[]): string | null {
  for (const entry of entries) {
    if (entry.isMeta) continue;
    const message = entry.message;
    if (!message || message.role !== 'user') continue;
    const text = contentToText(message.content);
    if (text) return text;
  }
  return null;
}

/**
 * Pure title extractor: the session `summary`/`type:"summary"` line when
 * present, else the first `user` text turn, else null. Exported for unit tests.
 */
export function extractClaudeTitle(entries: JsonlEntry[]): string | null {
  const summary = extractSummaryFromEntries(entries);
  if (summary) return truncateTitle(summary);
  const userText = firstUserText(entries);
  if (userText) return truncateTitle(userText);
  return null;
}

/** Read a session's entries + extract its title; null on any read failure. */
function safeTitle(filePath: string): string | null {
  try {
    return extractClaudeTitle(readSessionEntries(filePath));
  } catch {
    return null;
  }
}

export const claudeCodeAdapter: CliSourceAdapter = {
  id: SOURCE_ID,
  displayName: 'Claude Code',

  locateRoots(home: string): string[] {
    return [path.join(home, '.claude', 'projects')];
  },

  listProjects(roots: string[]): CliProjectRef[] {
    const out: CliProjectRef[] = [];
    for (const root of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue; // missing/unreadable projects root → degrade cleanly
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        const dir = path.join(root, slug);
        // Skip empty project dirs: Claude leaves behind directories that hold
        // only `sessions-index.json` (e.g. after their sessions were deleted).
        // Those have no `.jsonl` to read a `cwd` from, so they'd render as a
        // raw, undecodable slug with "no sessions" — not useful to browse.
        if (listSessionFilesInProject(dir).length === 0) continue;
        const cwd = probeProjectCwd(dir);
        // `label` falls back to the dir slug when the cwd is undecodable.
        out.push({ sourceId: SOURCE_ID, key: slug, cwd, label: cwd ? path.basename(cwd) : slug });
      }
    }
    return out;
  },

  countSessionsByProject(roots: string[]): Record<string, number> {
    // Counting is a readdir per project dir — deliberately NO stat/title reads
    // (listSessions reads every transcript for a title; counts must stay cheap).
    const counts: Record<string, number> = {};
    for (const root of roots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const n = listSessionFilesInProject(path.join(root, entry.name)).length;
        if (n > 0) counts[entry.name] = (counts[entry.name] ?? 0) + n;
      }
    }
    return counts;
  },

  listSessions(roots: string[], project: CliProjectRef): CliSessionRef[] {
    const out: CliSessionRef[] = [];
    for (const root of roots) {
      const dir = path.join(root, project.key);
      if (!fs.existsSync(dir)) continue;
      const cwd = probeProjectCwd(dir) ?? project.cwd;
      for (const file of listSessionFilesInProject(dir)) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file.filePath);
        } catch {
          continue;
        }
        out.push({
          sourceId: SOURCE_ID,
          projectKey: project.key,
          id: file.id,
          path: file.filePath,
          title: safeTitle(file.filePath),
          cwd,
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
        });
      }
    }
    return out;
  },

  resolveTranscriptPath(ref: CliSessionRef): string {
    return ref.path;
  },

  parseTranscriptToMessages(transcriptPath: string): ParsedMessage[] {
    return parseClaudeSession(transcriptPath);
  },
};
