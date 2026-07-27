import type { ReplayConvertedRequest, ReplayProtocolConverter } from './types.js';
import { ConverterUnsupportedFieldError } from './types.js';
import { encodeJsonBytes, parseJsonBytes } from './jsonBytes.js';

/**
 * `anthropic-to-openai-chat-v1`: maps an Anthropic Messages request body to an
 * OpenAI Chat Completions (`/v1/chat/completions`) request body, and maps a Chat
 * Completions response back to a syntactically valid Anthropic Messages
 * response. Structural protocol mapping only — message text, system prompts,
 * tool schemas, and content-block canaries survive unchanged at the converted
 * protocol position.
 *
 * The converter never sees the real API key; it declares the `bearer` auth
 * scheme and the transport layer attaches `Authorization: Bearer <key>`.
 */
export const anthropicToOpenaiChatV1: ReplayProtocolConverter = {
  id: 'anthropic-to-openai-chat-v1',
  version: '1.0.0',
  sourceProtocol: 'anthropic-messages',
  targetFormat: 'openai-chat-completions',
  convertRequest(cliRequestBody, context): ReplayConvertedRequest {
    const anthropic = parseJsonBytes(cliRequestBody) as AnthropicRequestBody;
    const chat = mapAnthropicRequestToChat(anthropic, context);
    // The proxy always sends `stream:false` upstream regardless of the CLI's
    // preference; streaming is synthesized on the way back if requested.
    chat.stream = false;
    return {
      targetPath: '/v1/chat/completions',
      authScheme: 'bearer',
      headers: { 'content-type': 'application/json' },
      body: encodeJsonBytes(chat),
    };
  },
  convertResponse(upstreamResponseBody, context): Uint8Array {
    const chat = parseJsonBytes(upstreamResponseBody) as ChatCompletionResponse;
    const anthropic = mapChatResponseToAnthropic(chat, context);
    return encodeJsonBytes(anthropic);
  },
};

// ---------------------------------------------------------------------------
// Anthropic Messages -> OpenAI Chat Completions (request)
// ---------------------------------------------------------------------------

interface AnthropicRequestBody {
  model?: unknown;
  max_tokens?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

interface ChatRequestMessage {
  role: string;
  content?: string | ChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatContentPart {
  type: 'text';
  text: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface ChatCompletionRequestBody {
  model: string;
  messages: ChatRequestMessage[];
  tools?: ChatTool[];
  max_tokens?: number;
  stream: boolean;
}

function mapAnthropicRequestToChat(
  anthropic: AnthropicRequestBody,
  context: { readonly upstreamModel: string },
): ChatCompletionRequestBody {
  const messages: ChatRequestMessage[] = [];

  // System prompt: Anthropic accepts a string or an array of content blocks.
  if (anthropic.system !== undefined && anthropic.system !== null) {
    messages.push({
      role: 'system',
      content: extractAnthropicSystemText(anthropic.system),
    });
  }

  const anthropicMessages = asArray(anthropic.messages, 'messages');
  for (const message of anthropicMessages) {
    mapAnthropicMessage(message, messages);
  }

  const chat: ChatCompletionRequestBody = {
    model: context.upstreamModel,
    messages,
    stream: false,
  };

  if (typeof anthropic.max_tokens === 'number' && Number.isFinite(anthropic.max_tokens)) {
    chat.max_tokens = Math.trunc(anthropic.max_tokens);
  }

  if (Array.isArray(anthropic.tools) && anthropic.tools.length > 0) {
    chat.tools = anthropic.tools.map(mapAnthropicTool);
  }

  return chat;
}

function mapAnthropicMessage(
  message: unknown,
  out: ChatRequestMessage[],
): void {
  if (!isObject(message)) {
    throw new ConverterUnsupportedFieldError('anthropic message must be an object');
  }
  const role = readString(message.role, 'message.role');
  const content = message.content;

  if (role === 'user' || role === 'assistant') {
    if (typeof content === 'string') {
      out.push({ role, content });
      return;
    }
    if (Array.isArray(content)) {
      mapAnthropicContentBlocks(role, content, out);
      return;
    }
    if (content === undefined) {
      out.push({ role, content: '' });
      return;
    }
    throw new ConverterUnsupportedFieldError(
      `unsupported content shape on ${role} message`,
    );
  }
  throw new ConverterUnsupportedFieldError(
    `unsupported anthropic message role: ${String(role)}`,
  );
}

function mapAnthropicContentBlocks(
  role: string,
  blocks: unknown[],
  out: ChatRequestMessage[],
): void {
  // Split a single Anthropic message into one or more Chat messages: text
  // blocks coalesce into the message content, tool_result blocks become
  // discrete {role:'tool'} messages, and tool_use blocks become assistant
  // tool_calls. Order is preserved across the emitted messages.
  let textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  const flushTextAndTools = () => {
    if (textParts.length === 0 && toolCalls.length === 0) {
      textParts.push('');
    }
    const entry: ChatRequestMessage = { role };
    if (textParts.length > 0) {
      entry.content = textParts.join('');
    } else {
      entry.content = '';
    }
    if (toolCalls.length > 0) {
      entry.tool_calls = [...toolCalls];
    }
    out.push(entry);
    textParts = [];
    toolCalls.length = 0;
  };

  for (const block of blocks) {
    if (!isObject(block)) {
      throw new ConverterUnsupportedFieldError(
        'anthropic content block must be an object',
      );
    }
    const type = readString(block.type, 'content block type');
    if (type === 'text') {
      textParts.push(readString(block.text, 'text block.text'));
    } else if (type === 'tool_use') {
      toolCalls.push({
        id: readString(block.id, 'tool_use.id'),
        type: 'function',
        function: {
          name: readString(block.name, 'tool_use.name'),
          arguments: JSON.stringify(readObject(block.input, 'tool_use.input')),
        },
      });
    } else if (type === 'tool_result') {
      // A tool_result starts a new logical turn: flush any pending text/tool_use
      // for the current message, then emit a discrete tool message.
      flushTextAndTools();
      out.push({
        role: 'tool',
        tool_call_id: readString(block.tool_use_id, 'tool_result.tool_use_id'),
        content: extractToolResultContent(block.content),
      });
    } else {
      throw new ConverterUnsupportedFieldError(
        `unsupported anthropic content block type: ${type}`,
      );
    }
  }
  flushTextAndTools();
}

function extractToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isObject(part) && readString(part.type, 'part.type') === 'text') {
          return readString(part.text, 'tool_result text');
        }
        throw new ConverterUnsupportedFieldError(
          'unsupported tool_result content part',
        );
      })
      .join('');
  }
  if (content === undefined || content === null) return '';
  throw new ConverterUnsupportedFieldError(
    'unsupported tool_result content shape',
  );
}

function mapAnthropicTool(tool: unknown): ChatTool {
  if (!isObject(tool)) {
    throw new ConverterUnsupportedFieldError('anthropic tool must be an object');
  }
  return {
    type: 'function',
    function: {
      name: readString(tool.name, 'tool.name'),
      description: readOptionalString(tool.description),
      parameters: tool.input_schema ?? undefined,
    },
  };
}

function extractAnthropicSystemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((part) => {
        if (isObject(part) && readString(part.type, 'system part.type') === 'text') {
          return readString(part.text, 'system.text');
        }
        throw new ConverterUnsupportedFieldError(
          'unsupported anthropic system content block',
        );
      })
      .join('');
  }
  throw new ConverterUnsupportedFieldError(
    'unsupported anthropic system shape',
  );
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions -> Anthropic Messages (response)
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  [key: string]: unknown;
}

interface AnthropicResponseMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
    };

function mapChatResponseToAnthropic(
  chat: ChatCompletionResponse,
  context: { readonly cliModel: string },
): AnthropicResponseMessage {
  const choices = asArray(chat.choices, 'choices');
  if (choices.length === 0) {
    throw new ConverterUnsupportedFieldError('chat response has no choices');
  }
  const choice = choices[0];
  if (!isObject(choice)) {
    throw new ConverterUnsupportedFieldError('chat choice must be an object');
  }
  const message = choice.message;
  if (!isObject(message)) {
    throw new ConverterUnsupportedFieldError('chat choice.message must be an object');
  }

  const content: AnthropicContentBlock[] = [];
  const messageContent = message.content;
  if (typeof messageContent === 'string' && messageContent.length > 0) {
    content.push({ type: 'text', text: messageContent });
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (isObject(part) && readString(part.type, 'content part.type') === 'text') {
        content.push({ type: 'text', text: readString(part.text, 'content.text') });
      } else {
        throw new ConverterUnsupportedFieldError(
          'unsupported chat response content part',
        );
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isObject(call)) {
        throw new ConverterUnsupportedFieldError('tool_call must be an object');
      }
      const fn = isObject(call.function) ? call.function : undefined;
      const input = parseToolCallArguments(fn?.arguments);
      content.push({
        type: 'tool_use',
        id: readString(call.id, 'tool_call.id'),
        name: readString(fn?.name, 'tool_call.function.name'),
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const finishReason = readOptionalString(choice.finish_reason) ?? 'stop';
  const stopReason = mapFinishReason(finishReason);
  const usage = parseChatUsage(chat.usage);

  return {
    id: readOptionalString(chat.id) ?? `msg_${randomId()}`,
    type: 'message',
    role: 'assistant',
    model: context.cliModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt,
      output_tokens: usage.completion,
    },
  };
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function parseChatUsage(usage: unknown): { prompt: number; completion: number } {
  if (!isObject(usage)) return { prompt: 0, completion: 0 };
  return {
    prompt: readNonNegInt(usage.prompt_tokens),
    completion: readNonNegInt(usage.completion_tokens),
  };
}

function parseToolCallArguments(argumentsValue: unknown): unknown {
  if (argumentsValue === undefined || argumentsValue === null) return {};
  if (typeof argumentsValue === 'string') {
    try {
      return JSON.parse(argumentsValue);
    } catch {
      return {};
    }
  }
  if (isObject(argumentsValue)) return argumentsValue;
  return {};
}

// ---------------------------------------------------------------------------
// Small defensive helpers (fail closed on shape mismatch).
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConverterUnsupportedFieldError(`${label} must be an array`);
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConverterUnsupportedFieldError(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ConverterUnsupportedFieldError(`${label} must be an object`);
  }
  return value;
}

function readNonNegInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return 0;
}

function randomId(): string {
  // Stable-ish throwaway id for responses that lacked one; the CLI does not
  // validate this beyond presence.
  return Math.random().toString(36).slice(2);
}
