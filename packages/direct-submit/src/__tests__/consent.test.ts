import { describe, expect, it } from 'vitest';

import { ConsentError, assertConsent, computeContentHash } from '../consent.js';
import { resolveProvider } from '../providers.js';
import { submit } from '../submit.js';
import { RULESET, VERSIONS, cleanSession, makeConsent, recordingTransport } from './_fixtures.js';

const target = resolveProvider('deepseek')!;

describe('informed-consent gate (bound to content)', () => {
  it('refuses when consent is absent', () => {
    expect(() => assertConsent(cleanSession(), undefined)).toThrow(ConsentError);
  });

  it('refuses when either acknowledgment is false', () => {
    const session = cleanSession();
    expect(() => assertConsent(session, makeConsent(session, { tosRiskAcknowledged: false }))).toThrow(
      ConsentError,
    );
    expect(() =>
      assertConsent(session, makeConsent(session, { fullRetentionAcknowledged: false })),
    ).toThrow(ConsentError);
  });

  it('refuses when the content hash is bound to different content', () => {
    const session = cleanSession();
    expect(() => assertConsent(session, makeConsent(session, { contentHash: 'deadbeef' }))).toThrow(
      ConsentError,
    );
  });

  it('accepts valid, content-bound consent and returns the hash', () => {
    const session = cleanSession();
    expect(assertConsent(session, makeConsent(session))).toBe(computeContentHash(session));
  });

  it('records the accepted consent in the receipt on a successful submit', async () => {
    const session = cleanSession();
    const consent = makeConsent(session);
    const { transport } = recordingTransport();
    const receipt = await submit({
      session,
      target,
      model: 'deepseek-v4-flash',
      consent,
      ruleset: RULESET,
      apiKey: 'sk-fake',
      transport,
      versions: VERSIONS,
    });
    expect(receipt.consent).toEqual(consent);
    expect(receipt.contentHash).toBe(computeContentHash(session));
    expect(receipt.backstopPassed).toBe(true);
    expect(receipt.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });
});
