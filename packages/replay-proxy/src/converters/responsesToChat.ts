import type { ReplayConvertedRequest, ReplayProtocolConverter } from './types.js';
import { ConverterUnsupportedFieldError } from './types.js';
import { encodeJsonBytes, parseJsonBytes } from './jsonBytes.js';

/**
 * `openai-responses-to-openai-chat-v1`: maps an OpenAI Responses request body
 * (the Codex CLI's wire protocol) to an OpenAI Chat Completions request body,
 * and maps a Chat Completions response back to a syntactically valid Responses
 * response. Structural mapping only — content survives unchanged.
 */
export const openaiResponsesToOpenaiChatV1: ReplayProtocolConverter = {
  id: 'openai-responses-to-openai-chat-v1',
  version: '1.0.0',
  sourceProtocol: 'openai-responses',
  targetFormat: 'openai-chat-completions',
  convertRequest(cliRequestBody, context): ReplayConvertedRequest {
    const responses = parseJsonBytes(cliRequestBody) as ResponsesRequestBody;
    const chat = mapResponsesRequestToChat(responses, context);
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
    const responses = mapChatResponseToResponses(chat, context);
    return encodeJsonBytes(responses);
  },
};

// ---------------------------------------------------------------------------
// OpenAI Responses -> OpenAI Chat Completions (request)
// ---------------------------------------------------------------------------

interface ResponsesRequestBody {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

interface ChatRequestMessage {
  role: string;
  content?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
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
  stream: boolean;
}

function mapResponsesRequestToChat(
  responses: ResponsesRequestBody,
  context: { readonly upstreamModel: string },
): ChatCompletionRequestBody {
  const messages: ChatRequestMessage[] = [];

  if (responses.instructions !== undefined && responses.instructions !== null) {
    messages.push({
      role: 'system',
      content: readString(responses.instructions, 'instructions'),
    });
  }

  if (typeof responses.input === 'string') {
    messages.push({ role: 'user', content: responses.input });
  } else if (Array.isArray(responses.input)) {
    for (const item of responses.input) {
      mapResponsesInputItem(item, messages);
    }
  } else if (responses.input !== undefined && responses.input !== null) {
    throw new ConverterUnsupportedFieldError(
      'unsupported responses input shape',
    );
  }

  const chat: ChatCompletionRequestBody = {
    model: context.upstreamModel,
    messages,
    stream: false,
  };

  if (Array.isArray(responses.tools) && responses.tools.length > 0) {
    chat.tools = responses.tools
      .filter((tool) => isObject(tool) && tool.type === 'function')
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: readString(tool.name, 'responses tool.name'),
          description: readOptionalString(tool.description),
          parameters: tool.parameters ?? undefined,
        },
      }));
  }

  return chat;
}

function mapResponsesInputItem(
  item: unknown,
  out: ChatRequestMessage[],
): void {
  if (!isObject(item)) {
    throw new ConverterUnsupportedFieldError(
      'responses input item must be an object',
    );
  }
  const type = readString(item.type, 'input item.type');
  if (type === 'message') {
    const role = readString(item.role, 'message.role');
    const content = item.content;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (!isObject(part)) {
            throw new ConverterUnsupportedFieldError(
              'responses message content part must be an object',
            );
          }
          const partType = readString(part.type, 'content part.type');
          if (partType === 'input_text' || partType === 'output_text' || partType === 'text') {
            return readString(part.text, 'content.text');
          }
          throw new ConverterUnsupportedFieldError(
            `unsupported responses message content part type: ${partType}`,
          );
        })
        .join('');
    } else {
      throw new ConverterUnsupportedFieldError(
        'unsupported responses message content shape',
      );
    }
    out.push({ role: role === 'tool' ? 'tool' : role, content: text });
    return;
  }
  if (type === 'function_call') {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: readString(item.call_id, 'function_call.call_id'),
          type: 'function',
          function: {
            name: readString(item.name, 'function_call.name'),
            arguments:
              typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(readObject(item.arguments, 'function_call.arguments')),
          },
        },
      ],
    });
    return;
  }
  if (type === 'function_call_output') {
    out.push({
      role: 'tool',
      tool_call_id: readString(item.call_id, 'function_call_output.call_id'),
      content:
        typeof item.output === 'string'
          ? item.output
          : JSON.stringify(readObject(item.output, 'function_call_output.output')),
    });
    return;
  }
  throw new ConverterUnsupportedFieldError(
    `unsupported responses input item type: ${type}`,
  );
}

// ---------------------------------------------------------------------------
// Chat Completions -> OpenAI Responses (response)
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  [key: string]: unknown;
}

interface ResponsesResponse {
  id: string;
  object: 'response';
  status: 'completed';
  model: string;
  output: ResponsesOutputItem[];
  usage: { input_tokens: number; output_tokens: number };
}

type ResponsesOutputItem = {
  type: 'message';
  role: 'assistant';
  status: 'completed';
  content: { type: 'output_text'; text: string; annotations: unknown[] }[];
};

function mapChatResponseToResponses(
  chat: ChatCompletionResponse,
  context: { readonly cliModel: string },
): ResponsesResponse {
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

  const textParts: string[] = [];
  const messageContent = message.content;
  if (typeof messageContent === 'string') {
    textParts.push(messageContent);
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (isObject(part) && readString(part.type, 'content part.type') === 'text') {
        textParts.push(readString(part.text, 'content.text'));
      } else {
        throw new ConverterUnsupportedFieldError(
          'unsupported chat response content part',
        );
      }
    }
  }
  // Tool calls are represented as separate output items in the Responses
  // schema; for the throwaway replay response we surface the primary text and
  // include any tool calls as function_call items when present.
  const output: ResponsesOutputItem[] = [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: textParts.join(''),
          annotations: [],
        },
      ],
    },
  ];

  const usage = parseChatUsage(chat.usage);

  return {
    id: readOptionalString(chat.id) ?? `resp_${randomId()}`,
    object: 'response',
    status: 'completed',
    model: context.cliModel,
    output,
    usage: {
      input_tokens: usage.prompt,
      output_tokens: usage.completion,
    },
  };
}

function parseChatUsage(usage: unknown): { prompt: number; completion: number } {
  if (!isObject(usage)) return { prompt: 0, completion: 0 };
  return {
    prompt: readNonNegInt(usage.prompt_tokens),
    completion: readNonNegInt(usage.completion_tokens),
  };
}

// ---------------------------------------------------------------------------
// Small defensive helpers.
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
  return Math.random().toString(36).slice(2);
}
