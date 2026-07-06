/**
 * Claude-meta string parsing for the native JSONL transcript reader.
 *
 * PROVENANCE: extracted VERBATIM from elftia
 * (`.../routers/legacy/parsers/JsonlClaudeMeta.ts`), MIT relicensed into mosga
 * under the initiator's copyright authorization (planning-context.md,
 * 2026-07-07). No external type dependencies.
 *
 * Claude Code writes a few "meta" string surfaces into the same JSONL stream as
 * real conversational turns:
 *   - slash commands, serialized as lightweight `<command-name>…</command-name>`
 *     XML-like tags inside a plain `role:'user'` string payload;
 *   - structured tool metadata, written as a SIBLING top-level `toolUseResult`
 *     field on a tool_result row (NOT inside `message.content`) — diffs, edit
 *     line counts, todo state, stdout/stderr, etc.
 *
 * These helpers live in a sibling file so `JsonlParser.ts` stays under its
 * `max-lines` budget and the Claude-meta string surface is isolated for focused
 * testing. They are all display-only and additive: the parser folds their
 * output into the existing `content` / `tc.result` channels and falls back to
 * current behavior when nothing matches (graceful no-op), so non-command rows,
 * non-edit tools, and pre-existing transcripts stay byte-shape-identical.
 *
 * Mirrors claudecodeui (cloudcli) `claude-sessions.provider.ts` for parity.
 */

/**
 * Parsed slash-command fields from Claude's local-command wrapper. All three
 * tags often coexist in one string payload; any may be empty.
 */
export type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Extract the inner text of a single `<tag>…</tag>` pair from a string.
 *
 * We intentionally parse only the small, fixed tag surface we care about with
 * one escaped-per-tag regex instead of introducing a general XML parser for
 * untrusted transcript history. Returns `null` when the tag is absent so the
 * caller can fall through to the unchanged text path.
 */
export function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

/**
 * Convert Claude's hidden local-command wrapper into structured metadata.
 *
 * Returns `null` when NONE of the three command tags are present, which lets
 * the normal text path continue untouched for ordinary user messages.
 */
export function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produce the short user-visible command string that should appear in chat.
 *
 * Prefer the slash-prefixed command name because that most closely matches what
 * the user actually typed, falling back to the message body only when no
 * command name is present (older transcript variants). Append the args when
 * present (`<name> <args>`); no trailing separator when args are absent.
 */
export function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

// --- toolUseResult summarization ----------------------------------------------

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null;
}

/** Render a `structuredPatch` (Claude's edit-diff format) into fenced hunks. */
function summarizeStructuredPatch(patch: unknown): string {
  if (!Array.isArray(patch) || patch.length === 0) return '';
  const lines: string[] = [];
  for (const hunkRaw of patch) {
    const hunk = asRecord(hunkRaw);
    if (!hunk) continue;
    const oldStart = typeof hunk.oldStart === 'number' ? hunk.oldStart : 0;
    const oldLines = typeof hunk.oldLines === 'number' ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === 'number' ? hunk.newStart : 0;
    const newLines = typeof hunk.newLines === 'number' ? hunk.newLines : 0;
    lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    if (Array.isArray(hunk.lines)) {
      for (const line of hunk.lines) {
        if (typeof line === 'string') lines.push(line);
      }
    }
  }
  if (lines.length === 0) return '';
  return ['```diff', ...lines, '```'].join('\n');
}

/** "edited `<file>` (+N/-M)" line counts when no structuredPatch is present. */
function summarizeFileEdit(record: AnyRecord): string {
  const filePath = typeof record.filePath === 'string' ? record.filePath : '';
  const additions = typeof record.numAdditions === 'number' ? record.numAdditions : undefined;
  const removals = typeof record.numRemovals === 'number' ? record.numRemovals : undefined;
  const hasEditShape =
    filePath || typeof record.oldString === 'string' || typeof record.newString === 'string';
  if (!hasEditShape && additions === undefined && removals === undefined) return '';
  const target = filePath ? `\`${filePath}\`` : 'file';
  if (additions !== undefined || removals !== undefined) {
    return `edited ${target} (+${additions ?? 0}/-${removals ?? 0})`;
  }
  return `edited ${target}`;
}

/** Short todo list ("- [status] content") from a `todos` array. */
function summarizeTodos(todos: unknown): string {
  if (!Array.isArray(todos) || todos.length === 0) return '';
  const lines: string[] = [];
  for (const todoRaw of todos) {
    const todo = asRecord(todoRaw);
    if (!todo) continue;
    const text = typeof todo.content === 'string' ? todo.content : '';
    if (!text) continue;
    const status = typeof todo.status === 'string' ? todo.status : 'pending';
    lines.push(`- [${status}] ${text}`);
  }
  return lines.length > 0 ? lines.join('\n') : '';
}

/** stdout/stderr/content text carried as siblings of an edit/command result. */
function summarizeStdio(record: AnyRecord): string {
  const parts: string[] = [];
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr] ${stderr}`);
  // A top-level `content` string (some tools carry their textual output here
  // rather than in `stdout`) — append it only when it is not already covered by
  // the stdout/stderr text, matching the design's "not already in content"
  // dedup guard so we never double-render the same output.
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  if (content && !parts.some((part) => part.includes(content))) {
    parts.push(content);
  }
  return parts.join('\n');
}

/**
 * Build a SCOPED, human-readable summary of a tool_result row's sibling
 * `toolUseResult` for the reference-surfaced shapes (structuredPatch/diff, file
 * edit + line counts, todos state, stdout/stderr). Returns `''` for
 * absent/malformed/unknown shapes so the caller's output is byte-shape-identical
 * to the `message.content`-only extraction (graceful no-op — load-bearing: a bad
 * shape must never corrupt the result text).
 */
export function summarizeToolUseResult(toolUseResult: unknown): string {
  const record = asRecord(toolUseResult);
  if (!record) return '';

  const sections: string[] = [];

  const patch = summarizeStructuredPatch(record.structuredPatch);
  if (patch) {
    sections.push(patch);
  } else {
    const edit = summarizeFileEdit(record);
    if (edit) sections.push(edit);
  }

  const todos = summarizeTodos(record.todos);
  if (todos) sections.push(todos);

  const stdio = summarizeStdio(record);
  if (stdio) sections.push(stdio);

  return sections.join('\n\n');
}
