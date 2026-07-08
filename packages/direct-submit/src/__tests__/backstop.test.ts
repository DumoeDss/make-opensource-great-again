import { describe, expect, it } from 'vitest';

import { SubmissionRefusedError, scanOutboundBytesBackstop } from '../backstop.js';
import { resolveProvider } from '../providers.js';
import { submit } from '../submit.js';
import {
  FAKE_AWS_KEY,
  FAKE_GITHUB_PAT,
  RULESET,
  VERSIONS,
  makeConsent,
  makeMessage,
  makeStampedSession,
  recordingTransport,
} from './_fixtures.js';

const target = resolveProvider('deepseek')!;

async function trySubmit(session: ReturnType<typeof makeStampedSession>) {
  const { transport, requests } = recordingTransport();
  const consent = makeConsent(session, { targetProviderId: 'deepseek', targetModel: 'deepseek-v4-flash' });
  const p = submit({
    session,
    target,
    model: 'deepseek-v4-flash',
    consent,
    ruleset: RULESET,
    apiKey: 'sk-fake',
    transport,
    versions: VERSIONS,
  });
  return { p, requests };
}

describe('pre-send raw-bytes backstop', () => {
  it('unit: reports a blocking secret in arbitrary outbound bytes', () => {
    const blocking = scanOutboundBytesBackstop(`token=${FAKE_GITHUB_PAT}`, RULESET);
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking.some((f) => f.layer === 'secrets')).toBe(true);
  });

  it('refuses a secret planted in a message, sending nothing', async () => {
    const session = makeStampedSession([
      makeMessage({ role: 'assistant', content: `deploy token: ${FAKE_GITHUB_PAT}` }),
    ]);
    const { p, requests } = await trySubmit(session);
    await expect(p).rejects.toBeInstanceOf(SubmissionRefusedError);
    expect(requests).toHaveLength(0);
  });

  it('refuses a secret reintroduced via the meta message (contributorAlias)', async () => {
    // The secret is only in meta.contributorAlias — which is serialized into the
    // meta terminal turn, part of the outbound bytes.
    const session = makeStampedSession(
      [makeMessage({ role: 'assistant', content: 'clean body' })],
      { contributorAlias: FAKE_AWS_KEY },
    );
    const { p, requests } = await trySubmit(session);
    await expect(p).rejects.toBeInstanceOf(SubmissionRefusedError);
    expect(requests).toHaveLength(0);
  });

  it('is independent of the human gate: a "sanitized" session with a surviving secret still refuses', async () => {
    // meta.sanitized:true (as if a human allowed it), yet the secret bytes remain.
    const session = makeStampedSession(
      [makeMessage({ role: 'assistant', content: `key ${FAKE_AWS_KEY}` })],
      { sanitized: true },
    );
    const { p, requests } = await trySubmit(session);
    await expect(p).rejects.toBeInstanceOf(SubmissionRefusedError);
    expect(requests).toHaveLength(0);
  });

  it('L3 normalization (paths/emails) does NOT block the send', async () => {
    const session = makeStampedSession([
      makeMessage({
        role: 'assistant',
        content: 'log at /home/alice/project/out.log, emailed alice@example.com',
      }),
    ]);
    const { p, requests } = await trySubmit(session);
    await expect(p).resolves.toBeDefined();
    expect(requests).toHaveLength(1);
  });
});
