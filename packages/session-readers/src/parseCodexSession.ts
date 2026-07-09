/**
 * Codex transcript parse entry (mirrors `parseClaudeSession.ts`).
 *
 * Reads a codex rollout file and delegates line mapping to
 * `parseCodexRolloutToMessages`. Unlike the Claude path — which reuses
 * `JsonlParser` byte-verbatim and marks non-text content in an external wrapper
 * — the codex non-text marker is stamped INLINE by the line-mapper (design D1),
 * because codex rollout items carry no stable per-item id to correlate against.
 * So this entry is a thin file reader, not a marking wrapper.
 *
 * `.jsonl.zst` policy (design D2): a compressed rollout parses to `[]` — no
 * decompression, no zstd dependency this slice. Missing/unreadable/zero-message
 * files also return `[]`. Never throws.
 */
import fs from 'node:fs';

import type { ParsedMessage } from '@mosga/contracts';

import { parseCodexRolloutToMessages } from './parsers/codexRollout.js';

export function parseCodexSession(transcriptPath: string): ParsedMessage[] {
  // Compressed rollouts are recognized but not decompressed this slice (D2).
  if (transcriptPath.endsWith('.zst')) return [];

  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return []; // missing/unreadable → degrade cleanly
  }
  if (!text.trim()) return [];

  return parseCodexRolloutToMessages(text.split('\n'));
}
