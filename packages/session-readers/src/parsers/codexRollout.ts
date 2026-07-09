/**
 * codexRollout — map a codex (`codex_cli_rs`) on-disk rollout transcript into
 * `@mosga/contracts` `ParsedMessage[]`.
 *
 * PROVENANCE: adapted from elftia's `codexRolloutParser.ts` (MIT reuse under the
 * initiator's authorization). Two deliberate divergences from the elftia source
 * (design D1):
 *   1. Types are re-pointed at `@mosga/contracts` (`ToolCall`, `ParsedMessage`)
 *      instead of elftia's `@shared/chat-types` — mirroring how `JsonlParser` /
 *      `types` were extracted for the Claude path.
 *   2. The non-text marker is stamped INLINE during this single pass. The Claude
 *      path reuses `JsonlParser` byte-verbatim and adds markers in an external
 *      wrapper (`parseClaudeSession`) that correlates raw entries to messages by
 *      `uuid`. Codex rollout items have NO stable per-item id (we synthesize a
 *      `randomUUID()` per emitted message, file order), so an external re-scan
 *      cannot reliably correlate a non-text part back to its message — the
 *      correlation is only trivially available here, in the mapping pass. The
 *      "mark, not strip" contract is upheld identically: a `message` content
 *      part that is not `input_text` (user) / `output_text` (assistant) stamps
 *      its `type` onto the emitted message's `nonTextContent.blockTypes`, never
 *      silently dropped.
 *
 * Codex writes one JSON object per line: `{ timestamp, type, payload }`.
 * `response_item` is the SINGLE SOURCE OF TRUTH for the conversation; the
 * parallel `event_msg` stream (`agent_message`/`user_message`/`agent_reasoning`
 * /`token_count`/`turn_aborted`) MIRRORS the response_items for live UI
 * streaming and is deliberately IGNORED — consuming both would double every
 * message. `turn_context` / `session_meta` are skipped.
 *
 * response_item payload mapping (Responses-API item model):
 *   - `message` role=user   → `{type:'input_text', text}` parts  → user message
 *     (injected `<environment_context>` / `<user_instructions>` scaffolding turns filtered)
 *   - `message` role=assistant → `{type:'output_text', text}` parts → assistant message
 *   - `reasoning` → `summary[].{type:'summary_text', text}` joined → assistant message
 *     carrying `thinking` (empty `content`)
 *   - `function_call` (`name`, `arguments` JSON STRING, `call_id`) → a `ToolCall` on a fresh assistant message
 *   - `function_call_output` (`call_id`, `output`) → merged onto the owning `ToolCall` by `call_id`
 *   - `custom_tool_call` (`name`, `input` STRING, `call_id`) → freeform-tool channel (e.g. `apply_patch`)
 *   - `custom_tool_call_output` (`call_id`, `output`) → merged by `call_id` like `function_call_output`
 *
 * Tool names + args are normalized to the shared vocabulary
 * (`shell`/`shell_command`→`Bash`, `update_plan`→`TodoWrite`) and tool outputs
 * are unwrapped from the `{output, metadata}` envelope (nonzero `exit_code`
 * → ToolCall `status: 'error'`) via `codexToolNormalize`.
 *
 * `compacted` is handled per elftia's lower-risk fallback: surface the summary
 * as a normal assistant message; apply NO compaction cut.
 *
 * Items are emitted in FILE ORDER. Codex items have no stable per-item uuid, so
 * we synthesize one per emitted message and leave `parentUuid: null`.
 * Unparseable lines are skipped (never throws). Mojibake in tool result bytes is
 * passed through UNMODIFIED (raw CLI output).
 */

import { randomUUID } from 'node:crypto';

import type { ParsedMessage, ToolCall } from '@mosga/contracts';

import { normalizeCodexTool, unwrapCodexOutput } from './codexToolNormalize.js';

/** One raw rollout line `{ timestamp, type, payload }` (loosely typed). */
interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ContentPart {
  type?: string;
  text?: string;
}

/** Parse `timestamp` (ISO string) → epoch ms, with a `Date.now()` fallback. */
function parseTs(value: unknown): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/** Join the text of content parts of a given block `type` (input/output_text). */
function joinContentText(content: unknown, partType: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as ContentPart;
      return p && p.type === partType && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Collect the distinct `type` strings of `message` content parts that are NOT
 * the role's text channel (`input_text` for user, `output_text` for assistant).
 * These are the non-text parts the reused parser would drop; the "mark, not
 * strip" contract requires surfacing them (design D1). Order-preserving, deduped.
 */
function collectNonTextParts(content: unknown, textType: string): string[] {
  if (!Array.isArray(content)) return [];
  const types: string[] = [];
  for (const part of content) {
    const p = part as ContentPart;
    // A part with a missing/non-string `type` is not text either — mark it as
    // `'unknown'` rather than dropping it silently (mark, not strip).
    const t = p && typeof p.type === 'string' ? p.type : 'unknown';
    if (t !== textType && !types.includes(t)) types.push(t);
  }
  return types;
}

/** Join `reasoning.summary[].summary_text` into a single thinking string. */
function joinReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((part) => {
      const p = part as ContentPart;
      return p && p.type === 'summary_text' && typeof p.text === 'string' ? p.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Parse a `function_call.arguments` JSON string with a safe `{}` fallback. */
function parseToolInput(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string') {
    return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Attach a `nonTextContent` marker only when non-text part types were found. */
function withNonText(message: ParsedMessage, nonTextTypes: string[]): ParsedMessage {
  if (nonTextTypes.length === 0) return message;
  return { ...message, nonTextContent: { blockTypes: nonTextTypes } };
}

function makeUserMessage(content: string, timestamp: number, nonTextTypes: string[]): ParsedMessage {
  return withNonText(
    {
      sdkUuid: randomUUID(),
      parentUuid: null,
      role: 'user',
      content,
      sdkMessageType: 'user',
      timestamp,
    },
    nonTextTypes,
  );
}

function makeAssistantMessage(
  content: string,
  timestamp: number,
  toolCalls?: ToolCall[],
  thinking?: string,
  nonTextTypes: string[] = [],
): ParsedMessage {
  return withNonText(
    {
      sdkUuid: randomUUID(),
      parentUuid: null,
      role: 'assistant',
      content,
      sdkMessageType: 'assistant',
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      thinking: thinking || undefined,
      timestamp,
    },
    nonTextTypes,
  );
}

/** Prefixes of codex-injected system scaffolding `message` role=user turns. */
const SCAFFOLDING_PREFIXES = ['<environment_context>', '<user_instructions>'];

/** True when a user turn's text is codex system scaffolding (prefix check only). */
function isScaffoldingUserTurn(content: string): boolean {
  const trimmed = content.trimStart();
  return SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Build a `ToolCall` from a codex call payload, normalizing the name + input to
 * the shared vocabulary. `rawInput` is the structured `function_call.arguments`
 * (already parsed) or `custom_tool_call.input` (parsed, or `{}` for a raw
 * non-JSON string — preserved by the caller).
 */
function buildCodexToolCall(
  callId: string,
  name: string,
  rawInput: Record<string, unknown>,
): ToolCall {
  const { name: normName, input } = normalizeCodexTool(name, rawInput);
  return { id: callId, name: normName, input, status: 'completed' };
}

/** Merge a codex tool output onto its owning ToolCall by `call_id`. */
function mergeCodexOutput(owner: ToolCall, rawOutput: unknown): void {
  const { result, isError } = unwrapCodexOutput(rawOutput);
  owner.result = result;
  owner.status = isError ? 'error' : 'completed';
}

/**
 * Project codex rollout lines (raw JSONL strings) into `ParsedMessage[]`.
 * Unparseable lines are skipped (never throws). Returns messages in file order.
 */
export function parseCodexRolloutToMessages(lines: string[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // Mirror `JsonlParser`'s tool-result map: collect outputs keyed by call_id,
  // merged onto the owning ToolCall as they arrive.
  const toolCallById = new Map<string, ToolCall>();

  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;

    let line: RolloutLine;
    try {
      line = JSON.parse(text) as RolloutLine;
    } catch {
      continue; // skip unparseable line
    }

    const ts = parseTs(line.timestamp);
    const payload = line.payload ?? {};

    // `response_item` is SSOT; `event_msg` (mirror), `turn_context`,
    // `session_meta` are skipped. `compacted` handled below.
    if (line.type === 'compacted') {
      // Lower-risk fallback (design D1 references elftia D3): surface the
      // compaction summary as a normal assistant message and apply NO cut — the
      // transcript is never blanked.
      const summary = typeof payload.message === 'string' ? payload.message : '';
      if (summary) messages.push(makeAssistantMessage(summary, ts));
      continue;
    }

    if (line.type !== 'response_item') continue;

    const itemType = payload.type;

    if (itemType === 'message') {
      const role = payload.role;
      if (role === 'user') {
        const content = joinContentText(payload.content, 'input_text');
        // Collect non-text parts BEFORE the scaffolding skip: a scaffolding turn
        // may still carry an image/attachment that must be surfaced.
        const nonText = collectNonTextParts(payload.content, 'input_text');
        // Skip codex-injected system scaffolding turns — but only their text. A
        // scaffolding turn bearing a non-text part still emits a marked, empty
        // message so the part is not silently dropped (mark, not strip).
        if (content && isScaffoldingUserTurn(content)) {
          if (nonText.length > 0) messages.push(makeUserMessage('', ts, nonText));
          continue;
        }
        // Emit when there is text OR a non-text part to surface — never drop the
        // part silently (mark, not strip).
        if (content || nonText.length > 0) {
          messages.push(makeUserMessage(content, ts, nonText));
        }
      } else if (role === 'assistant') {
        const content = joinContentText(payload.content, 'output_text');
        const nonText = collectNonTextParts(payload.content, 'output_text');
        if (content || nonText.length > 0) {
          messages.push(makeAssistantMessage(content, ts, undefined, undefined, nonText));
        }
      } else {
        // A message whose role is neither user nor assistant (e.g. system): its
        // text has no known channel and is not surfaced, but any non-text part
        // is still marked, not dropped. Both text channels count as text, so a
        // pure-text unknown-role message stays skipped.
        const nonText = collectNonTextParts(payload.content, 'input_text').filter(
          (t) => t !== 'output_text',
        );
        if (nonText.length > 0) messages.push(makeUserMessage('', ts, nonText));
      }
      continue;
    }

    if (itemType === 'reasoning') {
      // Reasoning is a text channel — carried on the dedicated `thinking` field
      // with empty `content`; not marked as non-text.
      const thinking = joinReasoningSummary(payload.summary);
      if (thinking) messages.push(makeAssistantMessage('', ts, undefined, thinking));
      continue;
    }

    if (itemType === 'function_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (!callId || !name) continue;
      const toolCall = buildCodexToolCall(callId, name, parseToolInput(payload.arguments));
      toolCallById.set(callId, toolCall);
      messages.push(makeAssistantMessage('', ts, [toolCall]));
      continue;
    }

    if (itemType === 'custom_tool_call') {
      // codex's freeform-tool channel (e.g. `apply_patch`). The call payload is
      // a STRING in `payload.input` — a JSON string for structured freeform
      // tools, a raw string (the patch text) otherwise.
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (!callId || !name) continue;
      const rawInput = typeof payload.input === 'string' ? payload.input : '';
      const parsed = parseToolInput(rawInput);
      // Non-JSON `input` parses to `{}` — preserve the raw patch/text as an
      // `input`-keyed fallback so nothing is lost (apply_patch passthrough).
      const structured =
        Object.keys(parsed).length > 0 ? parsed : rawInput ? { input: rawInput } : {};
      const toolCall = buildCodexToolCall(callId, name, structured);
      toolCallById.set(callId, toolCall);
      messages.push(makeAssistantMessage('', ts, [toolCall]));
      continue;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
      if (!callId) continue;
      const owner = toolCallById.get(callId);
      if (!owner) continue; // orphan output (no matching call) — drop
      // Unwrap codex's `{output, metadata}` envelope: surface the inner stdout
      // and derive an error flag from a nonzero `exit_code`. Non-envelope
      // outputs pass through verbatim (no mojibake repair).
      mergeCodexOutput(owner, payload.output);
      continue;
    }
  }

  return messages;
}
