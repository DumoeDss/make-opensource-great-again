import { describe, expect, it } from 'vitest';

import { estimate } from '../estimate.js';
import { resolveProvider } from '../providers.js';
import { NotStampedError, submit } from '../submit.js';
import {
  RULESET,
  VERSIONS,
  cleanSession,
  makeConsent,
  makeMessage,
  makeStampedSession,
  recordingTransport,
  toolSession,
} from './_fixtures.js';

const target = resolveProvider('deepseek')!;

describe('replay + estimation', () => {
  it('estimate produces a token count WITHOUT sending', () => {
    const est = estimate(cleanSession(), 'single-shot', { metaVersions: VERSIONS });
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.requestCount).toBe(1);
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('turn-by-turn (quadratic) estimate exceeds single-shot (linear) for the same session', () => {
    const session = toolSession();
    const single = estimate(session, 'single-shot', { metaVersions: VERSIONS });
    const turn = estimate(session, 'turn-by-turn', { metaVersions: VERSIONS });
    expect(turn.inputTokens).toBeGreaterThan(single.inputTokens);
    expect(turn.requestCount).toBeGreaterThan(single.requestCount);
  });

  it('single-shot is the default: one request ending on the meta user turn', async () => {
    const session = toolSession();
    const { transport, requests } = recordingTransport();
    const receipt = await submit({
      session,
      target,
      model: 'deepseek-v4-flash',
      consent: makeConsent(session),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    expect(receipt.replayMode).toBe('single-shot');
    expect(receipt.requestCount).toBe(1);
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages[body.messages.length - 1];
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('mosga-contribution-meta');
  });

  it('turn-by-turn sends one request per growing prefix plus the meta request', async () => {
    const session = toolSession();
    const { transport, requests } = recordingTransport();
    const receipt = await submit({
      session,
      target,
      model: 'deepseek-v4-flash',
      consent: makeConsent(session, { replayMode: 'turn-by-turn' }),
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    expect(receipt.replayMode).toBe('turn-by-turn');
    // 4 messages → 4 prefix requests + 1 final meta request.
    expect(requests.length).toBe(5);
    expect(receipt.requestCount).toBe(5);
  });

  it('refuses an un-stamped session', async () => {
    const session = makeStampedSession(
      [makeMessage({ role: 'assistant', content: 'x' })],
      { sanitized: false },
    );
    const { transport, requests } = recordingTransport();
    await expect(
      submit({
        session,
        target,
        model: 'deepseek-v4-flash',
        consent: makeConsent(session),
        ruleset: RULESET,
        apiKey: 'sk-fake',
        transport,
        versions: VERSIONS,
      }),
    ).rejects.toBeInstanceOf(NotStampedError);
    expect(requests).toHaveLength(0);
  });
});
