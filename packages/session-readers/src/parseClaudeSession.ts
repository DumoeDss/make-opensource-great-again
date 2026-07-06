/**
 * Non-text-content marker wrapper (design D5).
 *
 * The reused elftia parser (`parseContentBlocks`) extracts only
 * text/thinking/tool_use/tool_result blocks and silently drops everything else
 * (image/binary/unknown) — acceptable for a chat renderer, FORBIDDEN here: the
 * design doc mandates "mark, not strip" and bans silent truncation, because an
 * image has no automatic scan defense and a human must see it before export.
 *
 * This wrapper keeps the reused parse path VERBATIM (byte-for-byte parse
 * fidelity, mechanical future elftia re-sync) and, alongside it, re-scans the
 * raw deduplicated entries for non-text blocks, stamping a marker on the
 * `ParsedMessage` that the offending content actually lands on. The downstream
 * ⚠ human-review path (slice 3) keys off this marker.
 *
 * Non-text can hide in three places, ALL of which must be surfaced:
 *   1. a top-level block on an entry that becomes a message (e.g. a pasted
 *      image alongside text) → mark that message;
 *   2. NESTED inside a `tool_result`'s own `content[]` (a screenshot / `Read`-
 *      of-image returned by a tool) → the reused parser folds the result into
 *      the paired `tool_use` message, so the marker must land there, resolved
 *      via `tool_use_id`, NOT on the raw `tool_result` row (which never
 *      materializes as its own message);
 *   3. on an entry that never materializes at all (`isMeta` / `isApiErrorMessage`
 *      / merged `tool_result` / no-uuid rows) → surfaced on the nearest emitted
 *      message so the presence is never lost.
 */
import type { ParsedMessage } from '@mosga/contracts';

import { readSessionEntries } from './filesystem.js';
import { deduplicateEntries, parseJsonlEntriesToAgentMessages } from './parsers/JsonlParser.js';
import type { ContentBlock } from './types.js';

/**
 * Top-level block types the reused parser already handles as text-ish content.
 * `tool_result` is handled SEPARATELY below (we must recurse into its nested
 * `content[]`), so it is intentionally NOT in this set.
 */
const TEXT_BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use']);

function blockType(block: ContentBlock): string {
  return typeof block.type === 'string' ? block.type : 'unknown';
}

/**
 * Parse a Claude Code transcript to `ParsedMessage[]` via the clean parse path,
 * marking any message whose source content (top-level OR nested in a
 * `tool_result`, OR on a non-materializing sibling row) carried non-text blocks.
 * Returns `[]` on a missing/unreadable/zero-message file.
 */
export function parseClaudeSession(transcriptPath: string): ParsedMessage[] {
  const entries = deduplicateEntries(readSessionEntries(transcriptPath));
  // The reused parser is called on the SAME deduplicated entries — verbatim,
  // no edits. Its output is a superset-compatible subset of ParsedMessage.
  const messages = parseJsonlEntriesToAgentMessages(entries) as ParsedMessage[];
  if (messages.length === 0) return messages;

  // Resolution maps: a top-level non-text block targets the message emitted for
  // its own entry (by uuid); a `tool_result`-nested non-text block targets the
  // `tool_use` message it merges into (by tool_use_id).
  const messageByUuid = new Map<string, ParsedMessage>();
  const messageByToolUseId = new Map<string, ParsedMessage>();
  for (const message of messages) {
    messageByUuid.set(message.sdkUuid, message);
    for (const call of message.toolCalls ?? []) {
      messageByToolUseId.set(call.id, message);
    }
  }
  // Ultimate fallback so a detected block is never dropped for lack of a precise
  // carrier (its origin row didn't materialize and no neighbor is known yet).
  const firstMessage = messages[0];

  const markers = new Map<ParsedMessage, Set<string>>();
  const mark = (target: ParsedMessage | undefined, type: string): void => {
    const carrier = target ?? firstMessage;
    let set = markers.get(carrier);
    if (!set) {
      set = new Set<string>();
      markers.set(carrier, set);
    }
    set.add(type);
  };

  // Walk entries in order, tracking the most recent materialized message so an
  // orphan (non-materializing) row can surface on the nearest neighbor.
  let lastEmitted: ParsedMessage | undefined;
  for (const entry of entries) {
    const ownMessage = entry.uuid ? messageByUuid.get(entry.uuid) : undefined;
    if (ownMessage) lastEmitted = ownMessage;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = blockType(block);

      if (type === 'tool_result') {
        // Recurse into the tool result's own content array. The reused parser
        // keeps only nested `text`; every other nested block is dropped, so
        // mark it on the tool_use message this result merges into.
        const nested = block.content;
        if (!Array.isArray(nested)) continue;
        const target =
          (typeof block.tool_use_id === 'string' && messageByToolUseId.get(block.tool_use_id)) ||
          ownMessage ||
          lastEmitted;
        for (const inner of nested) {
          if (!inner || typeof inner !== 'object') continue;
          const innerType = blockType(inner);
          if (innerType === 'text') continue; // the only nested type kept as text
          mark(target, innerType);
        }
        continue;
      }

      if (TEXT_BLOCK_TYPES.has(type)) continue;

      // A top-level non-text block: mark its own message, or the nearest
      // neighbor when the origin row did not materialize.
      mark(ownMessage ?? lastEmitted, type);
    }
  }

  if (markers.size === 0) return messages;

  return messages.map((message) => {
    const set = markers.get(message);
    if (!set || set.size === 0) return message;
    return { ...message, nonTextContent: { blockTypes: Array.from(set) } };
  });
}
