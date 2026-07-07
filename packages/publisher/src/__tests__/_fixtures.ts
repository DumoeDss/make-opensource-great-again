import type { ParsedMessage, SanitizedSession } from '@mosga/contracts';
import { GITLEAKS_VERSION, compileRuleset } from '@mosga/sanitizer';

/**
 * Hand-crafted fake-data helpers for the publisher tests. ALL secrets here are
 * obviously-fake, non-functional canary values — never real keys, never real
 * session data.
 */

const AT = '2026-07-07T00:00:00.000Z';

/** The real compiled ruleset + version, so stamps/engine parity are realistic. */
export const RULESET = compileRuleset({ generatedAt: AT });
export const RULESET_VERSION = RULESET.rulesetVersion;
export const GITLEAKS_PIN = GITLEAKS_VERSION;

/** The installed @mosga/sanitizer version (matches its package.json). */
export const SANITIZER_PACKAGE_VERSION = '0.1.0';

// Obviously-fake canary secrets (structurally valid for their rule, but junk).
export const FAKE_GITHUB_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'; // ghp_ + 36
export const FAKE_AWS_KEY = 'AKIAFAKEFAKEFAKE1234'; // AKIA + 16 [A-Z0-9]

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

interface StampOptions {
  sanitized?: boolean;
  sanitizationRulesetVersion?: string | null;
  sessionId?: string;
  contributorAlias?: string;
  schemaVersion?: string;
  toolVersion?: string;
  sourceId?: string;
  projectKey?: string;
  cwd?: string | null;
}

/** A stamped (gate-passed) session envelope — the publisher's real input shape. */
export function makeStampedSession(
  messages: ParsedMessage[],
  opts: StampOptions = {},
): SanitizedSession {
  return {
    schemaVersion: opts.schemaVersion ?? '0.1.0',
    meta: {
      contributorAlias: opts.contributorAlias ?? '<USERNAME_1>',
      sourceCli: 'claude-code',
      toolVersion: opts.toolVersion ?? '0.1.0',
      sanitizationRulesetVersion:
        opts.sanitizationRulesetVersion === undefined
          ? RULESET_VERSION
          : opts.sanitizationRulesetVersion,
      exportedAt: AT,
      license: null,
      sanitized: opts.sanitized ?? true,
    },
    session: {
      sessionId: opts.sessionId ?? 'sess-abc123',
      sourceId: opts.sourceId ?? 'claude-code',
      projectKey: opts.projectKey ?? 'proj-1',
      cwd: opts.cwd === undefined ? null : opts.cwd,
      title: null,
      updatedAt: 1_700_000_000_000,
    },
    messages,
  };
}

/** A fully-clean stamped session (no findings at all). */
export function cleanSession(): SanitizedSession {
  return makeStampedSession([
    makeMessage({ role: 'user', content: 'Please refactor the parser to be more readable.' }),
    makeMessage({ role: 'assistant', content: 'Done — I split the parser into three helpers.' }),
  ]);
}

/** A stamped session whose bytes STILL contain a fake canary secret (a leak). */
export function canarySession(): SanitizedSession {
  return makeStampedSession([
    makeMessage({
      role: 'assistant',
      content: `Here is the deploy token I used: ${FAKE_GITHUB_PAT}`,
    }),
  ]);
}

/** A stamped session with only non-blocking Layer-3 normalization findings. */
export function normalizationOnlySession(): SanitizedSession {
  return makeStampedSession([
    makeMessage({
      role: 'assistant',
      content: 'The log file lives at /home/alice/project/out.log and I emailed alice@example.com.',
    }),
  ]);
}
