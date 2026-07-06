/**
 * Claude Code JSONL → agent-message parser.
 *
 * PROVENANCE: extracted VERBATIM from elftia
 * (`.../routers/legacy/parsers/JsonlParser.ts`), MIT relicensed into mosga under
 * the initiator's copyright authorization (planning-context.md, 2026-07-07). The
 * ONLY change from upstream is the type import (design D2): `ChatMessageRole` /
 * `ToolCall` now come from `@mosga/contracts` instead of elftia's
 * `@shared/chat-types` (aliased so the function bodies stay byte-for-byte
 * identical). Function logic is unchanged.
 */
import type { Role as ChatMessageRole, ToolCall } from '@mosga/contracts';

import type { ContentBlock, JsonlEntry, ParsedAgentMessage } from '../types.js';

import {
  buildLocalCommandDisplayText,
  parseLocalCommandPayload,
  summarizeToolUseResult
} from './JsonlClaudeMeta.js';

/**
 * Safely stringify JSON with error handling.
 */
export function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Normalize timestamp from various formats to number.
 */
export function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

/**
 * Normalize role for agent chat
 */
export function normalizeAgentRole(role: unknown): ChatMessageRole {
  if (role === 'assistant' || role === 'system') {
    return role;
  }
  return 'user';
}

/**
 * Deduplicate JSONL entries by UUID, keeping the latest version
 */
export function deduplicateEntries(entries: JsonlEntry[]): JsonlEntry[] {
  const entryMap = new Map<string, JsonlEntry>();

  for (const entry of entries) {
    const uuid = entry.uuid;
    if (!uuid) {
      // Entries without UUID are kept as-is (generate a unique key)
      const key = `no-uuid-${entryMap.size}-${entry.timestamp || Date.now()}`;
      entryMap.set(key, entry);
      continue;
    }

    const existing = entryMap.get(uuid);
    if (!existing) {
      entryMap.set(uuid, entry);
    } else {
      // Keep the entry with the later timestamp
      const existingTime = normalizeTimestamp(existing.timestamp);
      const newTime = normalizeTimestamp(entry.timestamp);
      if (newTime > existingTime) {
        entryMap.set(uuid, entry);
      }
    }
  }

  return Array.from(entryMap.values());
}

/**
 * Extract content from tool result block
 */
export function extractToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block.type === 'text' && block.text) return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Parse content blocks to extract text, tool calls, and tool results
 */
export function parseContentBlocks(content: string | ContentBlock[] | undefined): {
  textContent: string;
  thinking: string | undefined;
  toolCalls: ToolCall[];
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
} {
  const toolCalls: ToolCall[] = [];
  const toolResults: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  if (!content) {
    return { textContent: '', thinking: undefined, toolCalls, toolResults };
  }

  if (typeof content === 'string') {
    return { textContent: content, thinking: undefined, toolCalls, toolResults };
  }

  if (!Array.isArray(content)) {
    return { textContent: '', thinking: undefined, toolCalls, toolResults };
  }

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    switch (block.type) {
      case 'text':
        if (block.text) {
          textParts.push(block.text);
        }
        break;

      case 'thinking': {
        // Claude serializes reasoning text under `thinking`; tolerate `text`
        // as a fallback for alternate serializations.
        const reasoning = block.thinking ?? block.text;
        if (reasoning) {
          thinkingParts.push(reasoning);
        }
        break;
      }

      case 'tool_use':
        if (block.id && block.name) {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input || {},
            status: 'completed' // Legacy imports are completed
          });
        }
        break;

      case 'tool_result':
        if (block.tool_use_id) {
          const resultContent = extractToolResultContent(block.content);
          toolResults.push({
            toolUseId: block.tool_use_id,
            content: resultContent,
            isError: block.is_error === true
          });
        }
        break;
    }
  }

  return {
    textContent: textParts.join('\n').trim(),
    thinking: thinkingParts.join('\n').trim() || undefined,
    toolCalls,
    toolResults
  };
}

/**
 * Parse JSONL entries to agent chat message format
 */
export function parseJsonlEntriesToAgentMessages(entries: JsonlEntry[]): ParsedAgentMessage[] {
  const messages: ParsedAgentMessage[] = [];
  // Collect tool results for merging later. `summary` carries a scoped,
  // human-readable rendering of the row's sibling `toolUseResult` (diffs, edit
  // line counts, todos, stdout/stderr) folded in at merge time; '' when absent.
  const toolResultsMap = new Map<string, { content: string; isError: boolean; summary: string }>();

  for (const entry of entries) {
    // Skip entries without message content
    if (!entry.message?.content && entry.type !== 'summary') {
      continue;
    }

    // Skip API error messages
    if (entry.isApiErrorMessage) {
      continue;
    }

    // Skip Claude meta/system rows (local-command echoes, system-reminder rows
    // that are not real conversational turns). Flag-only gate — a normal text
    // row that merely contains a `<system-reminder>`-like substring is NOT
    // filtered. Most meta rows are already dropped downstream by the no-content
    // `continue`; this makes the skip explicit and intent-revealing, mirroring
    // the strict `isCompactSummary === true` precedent.
    if (entry.isMeta === true) {
      continue;
    }

    const uuid = entry.uuid || crypto.randomUUID();
    const timestamp = normalizeTimestamp(entry.timestamp);
    // Propagate the subagent flag onto the emitted message so the native
    // reader can keep Task/subagent turns out of the main spine (the legacy
    // importer ignores this field, so import stays flat).
    const isSidechain = entry.isSidechain === true;

    // Parse content blocks
    const content = entry.message?.content;
    const { textContent, thinking, toolCalls, toolResults } = parseContentBlocks(content);

    // Determine the actual role and message type
    // In Claude's JSONL format:
    // - role="user" with tool_result blocks -> this is a tool result message
    // - role="assistant" with tool_use blocks -> assistant with tool calls
    // - role="user" with text -> normal user message
    // - role="assistant" with text -> normal assistant message

    let role: ChatMessageRole = normalizeAgentRole(entry.message?.role);
    let sdkMessageType = entry.type || role;
    let finalContent = textContent;
    // Parsed slash-command fields, stamped onto the emitted message when this
    // user row was Claude's `<command-name>…` wrapper (set just below).
    let commandFields: { commandName: string; commandMessage: string; commandArgs: string } | null =
      null;

    // M4 — Claude `/compact` writes its summary as a `role:'user'` string row
    // flagged `isCompactSummary`. Re-label it to an assistant summary so it
    // renders as an assistant bubble (NOT a giant user bubble). Strict gate so
    // a normal user turn is never mis-relabeled. NOTE: deliberately NOT emitted
    // as a `context_summary` event — that would trigger the display
    // projection's compaction cut and HIDE the prior turns the JSONL retains.
    if (
      entry.isCompactSummary === true &&
      typeof content === 'string' &&
      normalizeAgentRole(entry.message?.role) === 'user'
    ) {
      role = 'assistant';
      sdkMessageType = 'assistant';
    }

    // Slash-command unwrap — Claude serializes a `/cmd args` slash command as a
    // `role:'user'` string row wrapping `<command-name>…</command-name>` (+
    // optional `<command-message>`/`<command-args>`). Detect the small fixed
    // tag surface and render a clean command string instead of raw XML noise,
    // and surface the parsed fields. Sits AFTER the compact-summary relabel
    // (a slash row is never `isCompactSummary`) and BEFORE the generic text
    // path; on no match it falls through unchanged (current behavior).
    if (typeof content === 'string' && role === 'user') {
      const payload = parseLocalCommandPayload(content);
      if (payload) {
        const displayText = buildLocalCommandDisplayText(payload);
        if (displayText) {
          finalContent = displayText;
          commandFields = payload;
        }
      }
    }

    // Check if this is actually a tool_result message disguised as "user"
    if (toolResults && toolResults.length > 0) {
      // The sibling top-level `toolUseResult` (NOT inside `message.content`)
      // carries this entry's structured tool metadata; summarize once per entry
      // and fold it into each paired result at merge time. '' for absent/odd
      // shapes (graceful no-op → byte-shape-identical output).
      const summary = summarizeToolUseResult(entry.toolUseResult);
      // Collect tool results for merging with corresponding tool calls
      for (const result of toolResults) {
        toolResultsMap.set(result.toolUseId, {
          content: result.content,
          isError: result.isError,
          summary
        });
      }
      // Skip creating a separate message for tool results
      // They will be merged into the corresponding tool_use message
      continue;
    } else if (toolCalls && toolCalls.length > 0) {
      // Assistant message with tool calls
      sdkMessageType = 'assistant';
      role = 'assistant';
      // Don't generate [Tool: xxx] text - let the UI render the toolCalls directly
      // Keep finalContent as the original text content (could be empty)
    }

    // Skip messages with no meaningful content at all. A thinking-ONLY
    // assistant turn (no text, no tool calls) is kept so its reasoning is not
    // double-dropped here and at the display projection.
    if (!finalContent && (!toolCalls || toolCalls.length === 0) && !thinking) {
      continue;
    }

    messages.push({
      sdkUuid: uuid,
      parentUuid: entry.parentUuid ?? null,
      role,
      content: finalContent,
      sdkMessageType,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: undefined, // Tool results will be merged into toolCalls
      ...(thinking ? { thinking } : {}),
      ...(isSidechain ? { isSidechain: true } : {}),
      ...(commandFields
        ? {
            commandName: commandFields.commandName,
            commandMessage: commandFields.commandMessage,
            commandArgs: commandFields.commandArgs
          }
        : {}),
      timestamp,
    });
  }

  // Merge tool results into corresponding tool calls
  if (toolResultsMap.size > 0) {
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const result = toolResultsMap.get(tc.id);
          if (result) {
            // Fold the scoped `toolUseResult` summary into the result string:
            // `message.content` first, then a separator + summary — only when
            // the summary is non-empty AND not already a substring of the
            // content (avoid duplicating text the result already carried). An
            // absent/'' summary leaves `tc.result` byte-identical to today.
            const summary = result.summary;
            tc.result =
              summary && !result.content.includes(summary)
                ? result.content
                  ? `${result.content}\n\n${summary}`
                  : summary
                : result.content;
            tc.status = result.isError ? 'error' : 'completed';
          }
        }
      }
    }
  }

  return messages;
}
