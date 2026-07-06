/**
 * JSONL entry / content-block / parsed-message shapes for the Claude Code
 * transcript parser.
 *
 * PROVENANCE: extracted from elftia
 * (`packages/desktop/app/main/services/routers/legacy/types.ts`). elftia is
 * GPLv3 upstream but under the initiator's copyright; the initiator has
 * authorized direct MIT relicense of this session-parsing layer into mosga
 * (planning-context.md, 2026-07-07). The shapes are kept verbatim except that
 * `ParsedAgentMessage`'s `role`/tool types are re-pointed at `@mosga/contracts`
 * primitives (design D2) instead of elftia's `@shared/chat-types`.
 */
import type { Role as ChatMessageRole, ToolCall } from '@mosga/contracts';

/**
 * JSONL entry structure from Claude Code CLI
 */
export interface JsonlEntry {
  sessionId?: string;
  type?: string;
  summary?: string;
  leafUuid?: string;
  parentUuid?: string | null;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  isApiErrorMessage?: boolean;
  /**
   * 1/true = subagent (Task) transcript line. Claude Code writes this on
   * subagent turns so a reader can keep them out of the main spine. Optional +
   * additive: the legacy importer never reads it (import stays flat).
   */
  isSidechain?: boolean;
  /**
   * true = this `role:'user'` string row is Claude's `/compact` summary (NOT a
   * real user turn). The native reader re-labels it to an assistant summary
   * message. Optional + additive.
   */
  isCompactSummary?: boolean;
  /**
   * true = Claude meta/system row (local-command echo, system-reminder rows
   * that are not real conversational turns). The native reader skips these
   * early — same shape as the `isApiErrorMessage` skip — so they never become
   * display bubbles. Optional + additive: the legacy importer skips them too
   * (they are not real turns there either), consistent with the `/compact`
   * relabel precedent.
   */
  isMeta?: boolean;
  /**
   * SIBLING top-level field on a tool_result row (NOT inside `message.content`).
   * Claude writes structured tool metadata here — `structuredPatch` diffs, file
   * edit line counts, `todos` state, `stdout`/`stderr`, etc. The native reader
   * folds a SCOPED, human-readable summary of this into the paired tool call's
   * result string. Optional + additive; absent/malformed shapes are a no-op.
   */
  toolUseResult?: unknown;
}

/**
 * Content block types in JSONL messages
 */
export interface ContentBlock {
  type: string;
  text?: string;
  /**
   * Text of a `thinking` block. Claude serializes reasoning under `thinking`
   * (with `text` as a tolerated fallback). Optional + additive.
   */
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

/**
 * Parsed message for agent chat import
 */
export interface ParsedAgentMessage {
  sdkUuid: string;
  parentUuid: string | null;
  role: ChatMessageRole;
  content: string;
  sdkMessageType: string;
  toolCalls?: ToolCall[];
  toolResults?: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }>;
  /**
   * Assistant reasoning text captured from `thinking` content blocks. Optional
   * + additive: threaded into the `assistant_message` payload's `thinking`
   * field by the native reader; ignored by the legacy importer.
   */
  thinking?: string;
  /**
   * Propagated from `JsonlEntry.isSidechain` — 1/true = subagent (Task) turn.
   * The native reader stamps it on the synthesized row so the display
   * projection's `mainSpine` guard excludes it. Ignored by the importer.
   */
  isSidechain?: boolean;
  /**
   * Parsed slash-command fields when this `user` row was Claude's
   * `<command-name>…</command-name>` wrapper (the `content` already carries the
   * clean display text). Optional + additive: surfaced for a future renderer to
   * style commands distinctly; ignored by the legacy importer.
   */
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  timestamp: number;
}
