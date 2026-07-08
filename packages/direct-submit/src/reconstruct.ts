import type {
  ContributionConsent,
  ContributionMeta,
  ParsedMessage,
  SanitizedSession,
} from '@mosga/contracts';
import { canonicalJson } from '@mosga/sanitizer';
import type {
  AnthropicChatRequest,
  AnthropicContentPart,
  AnthropicMessage,
  AnthropicTextContent,
} from '@omnicross/contracts/completion-types';

/** Meta payload schema version stamped into every contribution. */
export const META_VERSION = '0.2.0';

/** Default generation budget for the throwaway completion (ingestion-only). */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * The human-readable disclosure carried in the meta message. States that this is
 * a sanitized community contribution and that non-text media is absent (readers
 * mark-not-store non-text upstream, so replay is text-and-tool-structure only).
 */
const META_NOTE =
  'This is a sanitized, community-contributed AI coding trajectory submitted via mosga (出口②). ' +
  'It has passed a mandatory human review gate and a pre-send raw-bytes secret backstop. ' +
  'Non-text media (images/binaries) is not included — it is marked-not-stored upstream, so this ' +
  'trajectory is text-and-tool-structure only and must not be treated as complete-with-media.';

export interface MetaVersions {
  toolVersion: string;
  sanitizerPackageVersion: string;
}

/**
 * Build the `ContributionMeta` provenance payload from the stamped session and
 * the accepted consent. Carries NO API key material (consent ack is a key-free
 * subset).
 */
export function buildMetaMessage(
  session: SanitizedSession,
  consent: ContributionConsent,
  versions: MetaVersions,
): ContributionMeta {
  return {
    kind: 'mosga-contribution-meta',
    metaVersion: META_VERSION,
    toolVersion: versions.toolVersion,
    sanitizationRulesetVersion: session.meta.sanitizationRulesetVersion,
    sanitizerPackageVersion: versions.sanitizerPackageVersion,
    contributorAlias: session.meta.contributorAlias,
    license: session.meta.license,
    sourceCli: session.meta.sourceCli,
    sessionId: session.session.sessionId,
    consent: {
      consentVersion: consent.consentVersion,
      tosRiskAcknowledged: consent.tosRiskAcknowledged,
      fullRetentionAcknowledged: consent.fullRetentionAcknowledged,
      confirmedAt: consent.confirmedAt,
    },
    note: META_NOTE,
  };
}

/**
 * Serialize the meta message deterministically into turn text — a human-readable
 * note plus a canonical JSON block so both a person and a provider pipeline can
 * parse it. These bytes are part of the outbound request, so the backstop scans
 * them too.
 */
export function serializeMeta(meta: ContributionMeta): string {
  return `${meta.note}\n\n\`\`\`json\n${canonicalJson(meta)}\n\`\`\``;
}

/** Assemble the content blocks for one assistant turn: thinking, text, tool_use. */
function assistantContent(msg: ParsedMessage): AnthropicContentPart[] {
  const parts: AnthropicContentPart[] = [];
  if (msg.thinking && msg.thinking.length > 0) {
    parts.push({ type: 'thinking', thinking: msg.thinking });
  }
  if (msg.content.length > 0) parts.push({ type: 'text', text: msg.content });
  for (const call of msg.toolCalls ?? []) {
    parts.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return parts;
}

/** Assemble the content blocks for one user turn: tool_result first, then text. */
function userContent(msg: ParsedMessage): AnthropicContentPart[] {
  const parts: AnthropicContentPart[] = [];
  for (const result of msg.toolResults ?? []) {
    parts.push({
      type: 'tool_result',
      tool_use_id: result.toolUseId,
      content: result.content,
      is_error: result.isError,
    });
  }
  if (msg.content.length > 0) parts.push({ type: 'text', text: msg.content });
  return parts;
}

export interface ReconstructedConversation {
  messages: AnthropicMessage[];
  /** Concatenated `system`-role message text, if any. */
  system?: string;
}

/**
 * Rebuild the Anthropic `messages[]` from the isomorphic `SanitizedSession`
 * (text / thinking / `tool_use` from `toolCalls` / `tool_result` from
 * `toolResults`, roles preserved). `system`-role turns are folded into the
 * request `system` field (Anthropic messages carry only user/assistant). A turn
 * with no renderable content is skipped (Anthropic rejects empty content).
 */
export function toAnthropicMessages(session: SanitizedSession): ReconstructedConversation {
  const messages: AnthropicMessage[] = [];
  const systemParts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === 'system') {
      if (msg.content.length > 0) systemParts.push(msg.content);
      continue;
    }
    const content = msg.role === 'assistant' ? assistantContent(msg) : userContent(msg);
    if (content.length === 0) continue;
    messages.push({ role: msg.role, content });
  }

  const conv: ReconstructedConversation = { messages };
  if (systemParts.length > 0) conv.system = systemParts.join('\n\n');
  return conv;
}

export interface BuildRequestOptions {
  model: string;
  maxTokens?: number;
}

/**
 * Build the terminal-meta Anthropic request for single-shot ingestion: the whole
 * conversation followed by the meta message as the final user turn (so the
 * request ends on a user turn → exactly one assistant completion). The returned
 * request is the canonical form; OpenAI-format targets convert from it.
 */
export function buildAnthropicRequest(
  session: SanitizedSession,
  meta: ContributionMeta,
  options: BuildRequestOptions,
): AnthropicChatRequest {
  const conv = toAnthropicMessages(session);
  const metaTurn: AnthropicMessage = {
    role: 'user',
    content: [{ type: 'text', text: serializeMeta(meta) }],
  };
  const request: AnthropicChatRequest = {
    model: options.model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [...conv.messages, metaTurn],
  };
  if (conv.system) request.system = conv.system;
  return request;
}

/**
 * Fold assistant `thinking` blocks into delimited text BEFORE the omnicross
 * Anthropic→OpenAI converter runs. The converter has no `thinking` branch, so
 * without this the reasoning would be silently dropped from OpenAI-format
 * targets (contradicting the "full trajectory" reconstruction claim and the
 * no-silent-truncation rule), and a thinking-only assistant turn would convert
 * to `{content: null}` with no tool calls — a shape many OpenAI-compatible
 * providers reject. Folding preserves the reasoning as `<thinking>…</thinking>`
 * text and guarantees such a turn keeps non-null content. Anthropic-format
 * targets do NOT use this (native requests carry thinking blocks verbatim).
 */
export function foldThinkingIntoText(request: AnthropicChatRequest): AnthropicChatRequest {
  const messages = request.messages.map((msg): AnthropicMessage => {
    if (typeof msg.content === 'string') return msg;
    const thinking: string[] = [];
    const rest: AnthropicContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === 'thinking') thinking.push(part.thinking);
      else rest.push(part);
    }
    if (thinking.length === 0) return msg;
    const delimited = thinking.map((t) => `<thinking>\n${t}\n</thinking>`).join('\n');
    const firstText = rest.findIndex((p) => p.type === 'text');
    if (firstText >= 0) {
      const tb = rest[firstText] as AnthropicTextContent;
      rest[firstText] = { type: 'text', text: `${delimited}\n\n${tb.text}` };
    } else {
      // Thinking-only turn: a leading text block keeps the converted content non-null.
      rest.unshift({ type: 'text', text: delimited });
    }
    return { ...msg, content: rest };
  });
  return { ...request, messages };
}
