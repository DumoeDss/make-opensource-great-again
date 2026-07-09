import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../canonical.js';
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

let ruleset: CompiledRuleset;
function rs(): CompiledRuleset {
  if (!ruleset) {
    ruleset = compileRuleset({
      generatedAt: AT,
      customRules: [{ id: 'internal-project', kind: 'literal', pattern: 'Project-Zephyr' }],
    });
  }
  return ruleset;
}

describe('structure-aware location', () => {
  it('locates a secret that appears only in a tool-call result', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'running a command',
      toolCalls: [
        {
          id: 't1',
          name: 'Bash',
          input: { command: 'aws sts get-caller-identity' },
          status: 'completed',
          result: `AccessKeyId: ${FAKE_AWS_KEY}`,
        },
      ],
    });
    const session = makeSession([msg]);
    const { report } = scanSession(session, rs(), { generatedAt: AT });

    const secret = report.findings.find((f) => f.layer === 'secrets' && f.ruleId !== 'redos-guard');
    expect(secret).toBeDefined();
    expect(secret?.location.field).toBe('toolCallResult');
    expect(secret?.location.toolCallId).toBe('t1');
    expect(secret?.location.messageUuid).toBe(msg.sdkUuid);
  });

  it('indexes a tool-call input hit into the canonical serialization', () => {
    const input = { note: 'my token', token: FAKE_GITHUB_PAT };
    const msg = makeMessage({
      toolCalls: [{ id: 'tc', name: 'Set', input, status: 'completed' }],
    });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const f = report.findings.find((x) => x.location.field === 'toolCallInput');
    expect(f).toBeDefined();
    const serialized = canonicalJson(input);
    expect(serialized.slice(f!.location.span.start, f!.location.span.end)).toBe(FAKE_GITHUB_PAT);
  });

  it('round-trips a content finding location+span to the exact substring', () => {
    const content = `token here: ${FAKE_GITHUB_PAT} end`;
    const msg = makeMessage({ content });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const f = report.findings.find((x) => x.location.field === 'content' && x.blocking);
    expect(f).toBeDefined();
    expect(content.slice(f!.location.span.start, f!.location.span.end)).toBe(FAKE_GITHUB_PAT);
  });
});

describe('finding stability + layer semantics', () => {
  it('yields the same Finding.id across a re-scan', () => {
    const msg = makeMessage({ content: `key: ${FAKE_GITHUB_PAT}` });
    const session = makeSession([msg]);
    const a = scanSession(session, rs(), { generatedAt: AT }).report.findings.map((f) => f.id).sort();
    const b = scanSession(session, rs(), { generatedAt: AT }).report.findings.map((f) => f.id).sort();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('marks secrets/custom blocking and normalization non-blocking', () => {
    const msg = makeMessage({
      content: `contact me at dev@example.com about Project-Zephyr, key ${FAKE_GITHUB_PAT}`,
    });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const secrets = report.findings.filter((f) => f.layer === 'secrets' && f.ruleId !== 'redos-guard');
    const custom = report.findings.filter((f) => f.layer === 'custom');
    const email = report.findings.filter((f) => f.category === 'email');
    expect(secrets.every((f) => f.blocking)).toBe(true);
    expect(custom.length).toBeGreaterThan(0);
    expect(custom.every((f) => f.blocking)).toBe(true);
    expect(email.length).toBeGreaterThan(0);
    expect(email.every((f) => !f.blocking)).toBe(true);
  });

  it('redacts the secret in matchPreview', () => {
    const msg = makeMessage({ content: `key: ${FAKE_GITHUB_PAT}` });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const secret = report.findings.find((f) => f.layer === 'secrets' && f.ruleId !== 'redos-guard');
    expect(secret).toBeDefined();
    expect(secret!.matchPreview).not.toContain(FAKE_GITHUB_PAT);
  });
});

describe('allowlist suppression', () => {
  it('does not flag the AWS docs example key as blocking', () => {
    const msg = makeMessage({ content: `example only: ${AWS_DOCS_EXAMPLE_KEY}` });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const blocking = report.findings.filter((f) => f.blocking);
    expect(blocking).toHaveLength(0);
  });
});

describe('pseudonym mapping', () => {
  it('is consistent within a session', () => {
    const p = '/home/alice/project/app.ts';
    const session = makeSession([
      makeMessage({ content: `opened ${p}` }),
      makeMessage({ content: `edited ${p}` }),
      makeMessage({ content: `saved ${p}` }),
    ]);
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    const pathFindings = report.findings.filter((f) => f.category === 'path');
    expect(pathFindings.length).toBe(3);
    const suggestions = new Set(pathFindings.map((f) => f.replacementSuggestion));
    expect(suggestions.size).toBe(1);
  });

  it('is inconsistent across sessions with different encounter order', () => {
    const alice = '/home/alice/project';
    const bob = '/home/bob/project';
    const sessA = makeSession([makeMessage({ content: `${alice} then ${bob}` })]);
    const sessB = makeSession([makeMessage({ content: `${bob} then ${alice}` })]);
    const rA = scanSession(sessA, rs(), { generatedAt: AT }).report;
    const rB = scanSession(sessB, rs(), { generatedAt: AT }).report;
    const aliceInA = rA.findings.find((f) => f.category === 'path' && f.matchPreview === alice);
    const aliceInB = rB.findings.find((f) => f.category === 'path' && f.matchPreview === alice);
    expect(aliceInA?.replacementSuggestion).toBeDefined();
    expect(aliceInB?.replacementSuggestion).toBeDefined();
    expect(aliceInA!.replacementSuggestion).not.toBe(aliceInB!.replacementSuggestion);
  });
});

describe('report gate + non-text', () => {
  it('locks the gate while a blocking hit is pending', () => {
    const msg = makeMessage({ content: `key: ${FAKE_GITHUB_PAT}` });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    expect(report.gate.blockingPending).toBeGreaterThan(0);
    expect(report.gate.unlocked).toBe(false);
  });

  it('emits a NonTextItem for an image marker on a tool_use message without stripping content', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'here is the screenshot',
      toolCalls: [{ id: 's1', name: 'Screenshot', input: {}, status: 'completed' }],
      nonTextContent: { blockTypes: ['image'] },
    });
    const session = makeSession([msg]);
    const { report } = scanSession(session, rs(), { generatedAt: AT });
    expect(report.nonTextItems).toHaveLength(1);
    expect(report.nonTextItems[0].blockTypes).toContain('image');
    expect(report.nonTextItems[0].disposition).toBe('pending');
    // Scan never mutates the session; content is intact.
    expect(session.messages[0].content).toBe('here is the screenshot');
    expect(session.messages[0].nonTextContent?.blockTypes).toContain('image');
  });
});

describe('ipv6 normalization precision (timestamp false-positive regression)', () => {
  it('does not flag HH:MM:SS timestamps or short colon-hex runs as ipv6', () => {
    const msg = makeMessage({
      content: '05:15:08 build started, 23:59:59 finished, mac 00:11:22:33:44:55, verse 3:16',
    });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    expect(report.findings.filter((f) => f.category === 'ipv6')).toHaveLength(0);
  });

  it('still flags real IPv6 forms: full, middle/trailing compression, loopback', () => {
    const content =
      'full 2001:0db8:85a3:0000:0000:8a2e:0370:7334 mid 2001:db8::8a2e:370:7334 link fe80::1 lo ::1';
    const msg = makeMessage({ content });
    const { report } = scanSession(makeSession([msg]), rs(), { generatedAt: AT });
    const spans = report.findings
      .filter((f) => f.category === 'ipv6')
      .map((f) => content.slice(f.location.span.start, f.location.span.end))
      .sort();
    expect(spans).toEqual(
      ['2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:db8::8a2e:370:7334', '::1', 'fe80::1'].sort(),
    );
  });
});
