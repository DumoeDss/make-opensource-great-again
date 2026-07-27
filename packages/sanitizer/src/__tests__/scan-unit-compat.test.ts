import type { SanitizedSession } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import type { CompiledRuleset } from '../schemas.js';
import {
  scanSession,
  scanSessionLegacyReference,
} from '../scan.js';

const AT = '2026-07-27T00:00:00.000Z';

const ruleset: CompiledRuleset = {
  rulesetVersion: 'compat-rules-v1',
  gitleaksVersion: 'fake',
  generatedAt: AT,
  rules: [
    {
      id: 'fake-secret',
      description: 'fake canary',
      regexSource: 'FAKE_[A-Z0-9]{8}',
      flags: '',
      keywords: ['FAKE_'],
      translation: { status: 'native', notes: '' },
    },
  ],
  customRules: [
    {
      id: 'fake-project',
      kind: 'literal',
      pattern: 'Project-Zephyr',
      replacement: '<PROJECT>',
    },
  ],
  degraded: [],
};

const session: SanitizedSession = {
  schemaVersion: '0.1.0',
  meta: {
    contributorAlias: '<CONTRIBUTOR>',
    sourceCli: 'claude-code',
    toolVersion: '0.1.0',
    sanitizationRulesetVersion: null,
    exportedAt: AT,
    license: null,
    sanitized: false,
  },
  session: {
    sessionId: 'compat-session',
    sourceId: 'claude-code',
    projectKey: 'fake-project',
    cwd: '/Users/fake/repository',
    title: 'Project-Zephyr',
    updatedAt: 1,
  },
  messages: [
    {
      sdkUuid: 'uuid-1',
      parentUuid: null,
      role: 'assistant',
      content: 'secret FAKE_1234ABCD email fake@example.test',
      sdkMessageType: 'assistant',
      timestamp: 1,
      toolCalls: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { path: '/Users/fake/repository/file.ts' },
          status: 'completed',
          result: 'Project-Zephyr',
        },
      ],
      nonTextContent: { blockTypes: ['image'] },
    },
  ],
};

describe('shared detector scan-unit compatibility', () => {
  it('preserves every legacy finding, id, summary, non-text item, and gate', () => {
    const before = scanSessionLegacyReference(session, ruleset, {
      generatedAt: AT,
    });
    const after = scanSession(session, ruleset, { generatedAt: AT });

    expect(after.report).toEqual(before.report);
    expect(after.rulesetWarnings).toEqual(before.rulesetWarnings);
    expect(after.report.findings.map((finding) => finding.id)).toEqual(
      before.report.findings.map((finding) => finding.id),
    );
    expect(after.report.gate).toEqual(before.report.gate);
  });
});
