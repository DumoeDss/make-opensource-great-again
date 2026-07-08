import type { ContributionConsent, ParsedMessage, SanitizedSession } from '@mosga/contracts';
import { compileRuleset } from '@mosga/sanitizer';

import { computeContentHash } from '../consent.js';
import type { MetaVersions } from '../reconstruct.js';
import type { OutboundRequest, Transport } from '../transport.js';

/**
 * Hand-crafted fake-data helpers. ALL secrets here are obviously-fake,
 * non-functional canary values (repo convention) — never real keys, never real
 * session data. No test hits a real network.
 */

const AT = '2026-07-09T00:00:00.000Z';

export const RULESET = compileRuleset({ generatedAt: AT });

// Obviously-fake canary secrets (structurally valid for their rule, but junk).
export const FAKE_GITHUB_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'; // ghp_ + 36
export const FAKE_AWS_KEY = 'AKIAFAKEFAKEFAKE1234'; // AKIA + 16 [A-Z0-9]

// An obviously-fake provider API key — used to assert it never leaks.
export const FAKE_PROVIDER_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

export const VERSIONS: MetaVersions = { toolVersion: '0.1.0', sanitizerPackageVersion: '0.1.0' };

let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  return `msg-${uuidCounter}`;
}

export function makeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    sdkUuid: nextUuid(),
    parentUuid: null,
    role: 'assistant',
    content: '',
    sdkMessageType: 'message',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** A stamped (gate-passed) session — the direct-submit input shape. */
export function makeStampedSession(
  messages: ParsedMessage[],
  over: Partial<SanitizedSession['meta']> = {},
): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<USERNAME_1>',
      sourceCli: 'claude-code',
      toolVersion: '0.1.0',
      sanitizationRulesetVersion: RULESET.rulesetVersion,
      exportedAt: AT,
      license: 'MIT',
      sanitized: true,
      ...over,
    },
    session: {
      sessionId: 'sess-abc123',
      sourceId: 'claude-code',
      projectKey: 'proj-1',
      cwd: null,
      title: null,
      updatedAt: 1_700_000_000_000,
    },
    messages,
  };
}

/** A clean stamped session that round-trips tool_use / tool_result structure. */
export function toolSession(): SanitizedSession {
  return makeStampedSession([
    makeMessage({ role: 'user', content: 'List the files in src.' }),
    makeMessage({
      role: 'assistant',
      content: 'Let me look.',
      thinking: 'I should call the ls tool.',
      toolCalls: [{ id: 'tc-1', name: 'ls', input: { path: 'src' }, status: 'completed' }],
    }),
    makeMessage({
      role: 'user',
      content: '',
      toolResults: [{ toolUseId: 'tc-1', content: 'index.ts\napp.ts', isError: false }],
    }),
    makeMessage({ role: 'assistant', content: 'There are two files: index.ts and app.ts.' }),
  ]);
}

/** A clean, simple stamped session. */
export function cleanSession(): SanitizedSession {
  return makeStampedSession([
    makeMessage({ role: 'user', content: 'Please refactor the parser.' }),
    makeMessage({ role: 'assistant', content: 'Done — split into three helpers.' }),
  ]);
}

/** Build a valid, content-bound consent record for a session. */
export function makeConsent(
  session: SanitizedSession,
  over: Partial<ContributionConsent> = {},
): ContributionConsent {
  return {
    consentVersion: '0.2.0',
    tosRiskAcknowledged: true,
    fullRetentionAcknowledged: true,
    targetProviderId: 'deepseek',
    targetModel: 'deepseek-v4-flash',
    replayMode: 'single-shot',
    estimatedTokens: 1000,
    contentHash: computeContentHash(session),
    confirmedAt: AT,
    ...over,
  };
}

/** A recording mock transport: captures every outbound request, returns usage. */
export function recordingTransport(status = 200): {
  transport: Transport;
  requests: OutboundRequest[];
} {
  const requests: OutboundRequest[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    return { status, usage: { inputTokens: 42, outputTokens: 7 } };
  };
  return { transport, requests };
}
