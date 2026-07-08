import { describe, expect, it } from 'vitest';

import { buildMetaMessage, serializeMeta, toAnthropicMessages } from '../reconstruct.js';
import { submit } from '../submit.js';
import { resolveProvider } from '../providers.js';
import {
  RULESET,
  VERSIONS,
  makeConsent,
  makeMessage,
  makeStampedSession,
  recordingTransport,
  toolSession,
} from './_fixtures.js';

describe('toAnthropicMessages — round-trips tool_use / tool_result', () => {
  it('rebuilds thinking, text, tool_use, and tool_result blocks with roles preserved', () => {
    const { messages } = toAnthropicMessages(toolSession());
    // user, assistant(+tool_use), user(tool_result), assistant
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    const assistant = messages[1].content as Array<{ type: string }>;
    expect(assistant.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    const toolUse = assistant.find((b) => b.type === 'tool_use') as { id: string; name: string };
    expect(toolUse).toMatchObject({ id: 'tc-1', name: 'ls' });

    const userTurn = messages[2].content as Array<{ type: string; tool_use_id?: string }>;
    expect(userTurn[0].type).toBe('tool_result');
    expect(userTurn[0].tool_use_id).toBe('tc-1');
  });
});

describe('meta message', () => {
  it('carries provenance + consent ack and NO api key', () => {
    const session = toolSession();
    const consent = makeConsent(session);
    const meta = buildMetaMessage(session, consent, VERSIONS);
    expect(meta.kind).toBe('mosga-contribution-meta');
    expect(meta.contributorAlias).toBe(session.meta.contributorAlias);
    expect(meta.consent.tosRiskAcknowledged).toBe(true);
    // The disclosure states non-text media is absent.
    expect(meta.note.toLowerCase()).toContain('non-text');
    const serialized = serializeMeta(meta);
    expect(serialized).not.toContain('sk-');
  });
});

describe('format routing (task 4.2)', () => {
  it('OpenAI-format preset (deepseek) gets a converted request at the chat-completions endpoint', async () => {
    const session = toolSession();
    const target = resolveProvider('deepseek')!;
    const { transport, requests } = recordingTransport();
    await submit({
      session,
      target,
      model: 'deepseek-v4-flash',
      consent: makeConsent(session, { targetProviderId: 'deepseek', targetModel: 'deepseek-v4-flash' }),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(requests[0].body) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe('deepseek-v4-flash');
    // OpenAI shape: flat messages; the meta terminal turn is the last user message.
    expect(body.messages[body.messages.length - 1].role).toBe('user');
    expect(requests[0].headers.authorization).toBe('Bearer sk-fake');
  });

  it('folds assistant thinking into text for OpenAI targets (thinking survives conversion)', async () => {
    // toolSession's assistant turn carries thinking 'I should call the ls tool.'
    const session = toolSession();
    const target = resolveProvider('deepseek')!;
    const { transport, requests } = recordingTransport();
    await submit({
      session,
      target,
      model: 'deepseek-v4-flash',
      consent: makeConsent(session, { targetProviderId: 'deepseek', targetModel: 'deepseek-v4-flash' }),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    // The reasoning is not dropped: it appears, delimited, in the outbound bytes.
    expect(requests[0].body).toContain('<thinking>');
    expect(requests[0].body).toContain('I should call the ls tool.');
    // And the original assistant text is still present alongside it.
    expect(requests[0].body).toContain('Let me look.');
  });

  it('a thinking-only assistant turn converts to non-null content (no invalid OpenAI shape)', async () => {
    const session = makeStampedSession([
      makeMessage({ role: 'assistant', content: '', thinking: 'only reasoning here, no reply text' }),
    ]);
    const target = resolveProvider('deepseek')!;
    const { transport, requests } = recordingTransport();
    // Must NOT throw the null-content guard, and must send.
    await expect(
      submit({
        session,
        target,
        model: 'deepseek-v4-flash',
        consent: makeConsent(session, { targetProviderId: 'deepseek', targetModel: 'deepseek-v4-flash' }),
        ruleset: RULESET,
        apiKey: 'sk-fake',
        transport,
        versions: VERSIONS,
      }),
    ).resolves.toBeDefined();
    const body = JSON.parse(requests[0].body) as { messages: Array<{ role: string; content: unknown }> };
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content).not.toBeNull();
    expect(JSON.stringify(assistant!.content)).toContain('only reasoning here');
  });

  it('Anthropic-format preset gets the native request at the messages endpoint', async () => {
    const session = toolSession();
    const target = resolveProvider('anthropic')!;
    const { transport, requests } = recordingTransport();
    await submit({
      session,
      target,
      model: 'claude-opus-4-7',
      consent: makeConsent(session, { targetProviderId: 'anthropic', targetModel: 'claude-opus-4-7' }),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(requests[0].body) as { max_tokens: number; messages: unknown[] };
    // Native Anthropic shape carries max_tokens and structured content arrays.
    expect(typeof body.max_tokens).toBe('number');
    expect(requests[0].headers['x-api-key']).toBe('sk-fake');
    expect(requests[0].headers.authorization).toBeUndefined();
  });
});
