import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderTarget } from '../providers.js';
import { submit } from '../submit.js';
import { fetchTransport } from '../transport.js';
import { RULESET, VERSIONS, makeConsent, recordingTransport, toolSession } from './_fixtures.js';

const GEMINI_TARGET: ProviderTarget = {
  id: 'custom-gemini',
  name: 'Custom Gemini',
  apiFormat: 'gemini',
  apiBaseUrl: 'https://generativelanguage.googleapis.com',
  models: ['gemini-2.5-pro'],
};

const RESPONSES_TARGET: ProviderTarget = {
  id: 'custom-responses',
  name: 'Custom Responses',
  apiFormat: 'openai-response',
  apiBaseUrl: 'https://api.openai.com',
  models: ['gpt-x'],
};

const MODEL_GEMINI = 'gemini-2.5-pro';
const MODEL_RESPONSES = 'gpt-x';

describe('gemini format conversion', () => {
  it('POSTs a Gemini generateContent body to the Gemini URL with x-goog-api-key, thinking preserved', async () => {
    const session = toolSession(); // contains an assistant `thinking` block
    const { transport, requests } = recordingTransport();
    await submit({
      session,
      target: GEMINI_TARGET,
      model: MODEL_GEMINI,
      consent: makeConsent(session, { targetProviderId: 'custom-gemini', targetModel: MODEL_GEMINI }),
      ruleset: RULESET,
      apiKey: 'gk-fake',
      transport,
      versions: VERSIONS,
    });

    expect(requests).toHaveLength(1);
    const req = requests[0];
    // Right URL (model + action) and auth header.
    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(req.headers['x-goog-api-key']).toBe('gk-fake');
    expect(req.headers.authorization).toBeUndefined();

    const body = JSON.parse(req.body) as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
      generationConfig: { maxOutputTokens: number };
    };
    // Gemini shape: contents[] with mapped roles + a generationConfig budget.
    expect(Array.isArray(body.contents)).toBe(true);
    expect(body.contents.some((c) => c.role === 'model')).toBe(true); // assistant → model
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(0);
    // Thinking survived (folded into text, not dropped).
    expect(req.body).toContain('<thinking>');
    // The meta terminal turn is present (the backstop scanned this exact body).
    expect(req.body).toContain('mosga-contribution-meta');
  });
});

describe('openai-response format conversion', () => {
  it('POSTs a Responses-API body (input + max_output_tokens) to /v1/responses with Bearer auth', async () => {
    const session = toolSession();
    const { transport, requests } = recordingTransport();
    await submit({
      session,
      target: RESPONSES_TARGET,
      model: MODEL_RESPONSES,
      consent: makeConsent(session, {
        targetProviderId: 'custom-responses',
        targetModel: MODEL_RESPONSES,
      }),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });

    const req = requests[0];
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.authorization).toBe('Bearer sk-fake');

    const body = JSON.parse(req.body) as {
      model: string;
      input: unknown[];
      max_output_tokens: number;
      messages?: unknown;
      max_tokens?: unknown;
    };
    expect(body.model).toBe(MODEL_RESPONSES);
    expect(Array.isArray(body.input)).toBe(true); // messages → input
    expect(body.max_output_tokens).toBeGreaterThan(0); // max_tokens → max_output_tokens
    expect(body.messages).toBeUndefined(); // remapped, not left over
    expect(body.max_tokens).toBeUndefined();
    expect(req.body).toContain('<thinking>'); // reasoning preserved
  });
});

describe('usage parsing (fetchTransport, mocked global.fetch — no network)', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockJson(payload: unknown): void {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
  }

  it('parses Gemini usageMetadata (promptTokenCount / candidatesTokenCount)', async () => {
    mockJson({ usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22 } });
    const result = await fetchTransport({ url: 'x', method: 'POST', headers: {}, body: '{}' });
    expect(result.usage).toEqual({ inputTokens: 111, outputTokens: 22 });
  });

  it('parses OpenAI Responses usage (input_tokens / output_tokens)', async () => {
    mockJson({ usage: { input_tokens: 50, output_tokens: 9 } });
    const result = await fetchTransport({ url: 'x', method: 'POST', headers: {}, body: '{}' });
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 9 });
  });

  it('parses OpenAI chat usage (prompt_tokens / completion_tokens)', async () => {
    mockJson({ usage: { prompt_tokens: 7, completion_tokens: 3 } });
    const result = await fetchTransport({ url: 'x', method: 'POST', headers: {}, body: '{}' });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});
