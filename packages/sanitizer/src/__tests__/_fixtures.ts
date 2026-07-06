import type { ParsedMessage, SanitizedSession } from '@mosga/contracts';

/**
 * Hand-crafted fake-data helpers. ALL secrets here are obviously-fake,
 * non-functional canary values — never real keys, never real session data.
 */

// Obviously-fake canary secrets (structurally valid for their rule, but junk).
export const FAKE_AWS_KEY = 'AKIAFAKEFAKEFAKE1234'; // AKIA + 16 [A-Z0-9]
export const FAKE_GITHUB_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'; // ghp_ + 36
export const FAKE_GENERIC_SECRET = '9f3a7b2c8e1d6045af93b7c2e8d1f6a0z'; // high-entropy

// A documented, provably-non-secret example key that MUST be suppressed.
export const AWS_DOCS_EXAMPLE_KEY = 'AKIAIOSFODNN7EXAMPLE';

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

export function makeSession(
  messages: ParsedMessage[],
  sessionOverrides: Partial<SanitizedSession['session']> = {},
): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: '0.1.0',
      sanitizationRulesetVersion: null,
      exportedAt: '2026-07-07T00:00:00.000Z',
      license: null,
      sanitized: false,
    },
    session: {
      sessionId: 'sess-1',
      sourceId: 'claude-code',
      projectKey: 'proj-1',
      cwd: null,
      title: null,
      updatedAt: 1_700_000_000_000,
      ...sessionOverrides,
    },
    messages,
  };
}
