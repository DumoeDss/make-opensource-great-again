import { describe, expect, it } from 'vitest';

import { compileRuleset } from '../ingest.js';
import type { CompiledRuleset } from '../schemas.js';
import { scanSession } from '../scan.js';
import {
  AWS_DOCS_EXAMPLE_KEY,
  FAKE_AWS_KEY,
  FAKE_GITHUB_PAT,
  makeMessage,
  makeSession,
} from './_fixtures.js';

const AT = '2026-07-07T00:00:00.000Z';

// A generic high-entropy fake secret for the thinking position (obviously fake).
const FAKE_GENERIC = 'Xy9Kq2Lm7Pn4Rt6Vw8Yb1Dc3Fg5Hj0Qz';

let ruleset: CompiledRuleset;
function rs(): CompiledRuleset {
  if (!ruleset) ruleset = compileRuleset({ generatedAt: AT });
  return ruleset;
}

describe('canary: fake secrets caught at every structural position', () => {
  it('flags secrets in content, thinking, tool-call input, and tool-call result', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: `here is my GitHub token ${FAKE_GITHUB_PAT}`,
      thinking: `I should not have written password = "${FAKE_GENERIC}" here`,
      toolCalls: [
        {
          id: 'tc1',
          name: 'Bash',
          input: { command: `export TOKEN=${FAKE_GITHUB_PAT}` },
          status: 'completed',
          result: `caller identity AccessKeyId=${FAKE_AWS_KEY}`,
        },
      ],
    });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });

    const blockingFields = new Set(
      report.findings.filter((f) => f.blocking && f.ruleId !== 'redos-guard').map((f) => f.location.field),
    );
    expect(blockingFields.has('content')).toBe(true);
    expect(blockingFields.has('thinking')).toBe(true);
    expect(blockingFields.has('toolCallInput')).toBe(true);
    expect(blockingFields.has('toolCallResult')).toBe(true);

    // The AWS key sits in the tool-call result specifically, located there.
    const awsResult = report.findings.find(
      (f) => f.blocking && f.location.field === 'toolCallResult' && f.location.toolCallId === 'tc1',
    );
    expect(awsResult).toBeDefined();
    // No raw secret leaked into the persisted preview.
    expect(awsResult!.matchPreview).not.toContain(FAKE_AWS_KEY);
  });
});

describe('false-positive guard', () => {
  it('does not flag the AWS docs example key or benign secret-looking strings', () => {
    const msg = makeMessage({
      content: [
        `AWS documentation sample value ${AWS_DOCS_EXAMPLE_KEY} is a public example.`,
        'This line is ordinary prose with no credentials at all.',
        'Reference INT-0001 lives in the public tracker.',
      ].join('\n'),
    });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const blocking = report.findings.filter((f) => f.blocking);
    expect(blocking).toHaveLength(0);
  });

  it('uses only obviously-fake, structurally-nonfunctional canary values', () => {
    // Guard the guard: the fixtures are fake by construction — the AWS canary is
    // not the real example key, and the example key is a documented non-secret.
    expect(FAKE_AWS_KEY).not.toBe(AWS_DOCS_EXAMPLE_KEY);
    expect(FAKE_AWS_KEY).toMatch(/FAKE/);
    expect(FAKE_GITHUB_PAT).toMatch(/^ghp_[0-9a-zA-Z]{36}$/);
    expect(AWS_DOCS_EXAMPLE_KEY).toBe('AKIAIOSFODNN7EXAMPLE');
  });
});
