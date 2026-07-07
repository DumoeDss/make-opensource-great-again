import { describe, expect, it } from 'vitest';

import {
  PublishRefusedError,
  assertPrecheckClean,
  exportSession,
  precheckRecord,
} from '../index.js';
import {
  FAKE_AWS_KEY,
  FAKE_GITHUB_PAT,
  GITLEAKS_PIN,
  RULESET_VERSION,
  SANITIZER_PACKAGE_VERSION,
  canarySession,
  cleanSession,
  makeMessage,
  makeStampedSession,
  normalizationOnlySession,
} from './_fixtures.js';

const OPTS = { sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION };

describe('mandatory pre-check (the core safety gate)', () => {
  it('REFUSES a would-be-published artifact with a planted canary secret, emitting no output', () => {
    // The session is stamped (as if the human gate passed) but a fake secret
    // still sits in the bytes — the exact defense-in-depth case D2 exists for.
    const record = exportSession(canarySession(), OPTS);

    const result = precheckRecord(record.jsonl, OPTS);
    expect(result.ok).toBe(false);
    expect(result.blockingFindings.length).toBeGreaterThan(0);
    // No raw secret leaks into the reported preview.
    for (const f of result.blockingFindings) {
      expect(f.matchPreview).not.toContain(FAKE_GITHUB_PAT);
    }

    // The hard-refuse variant throws — a caller cannot ignore the leak and
    // proceed to write a file or open a PR.
    expect(() => assertPrecheckClean(record.jsonl, OPTS)).toThrow(PublishRefusedError);
  });

  it('PASSES a fully-sanitized artifact', () => {
    const record = exportSession(cleanSession(), OPTS);
    expect(precheckRecord(record.jsonl, OPTS).ok).toBe(true);
    expect(() => assertPrecheckClean(record.jsonl, OPTS)).not.toThrow();
  });

  it('still catches a human-allowed real secret that remains in the bytes', () => {
    // Even if a reviewer mistakenly marked the secret `allow` upstream, the
    // secret bytes are still present, so the byte-level re-scan re-detects it.
    const leaked = canarySession();
    const record = exportSession(leaked, OPTS);
    const result = precheckRecord(record.jsonl, OPTS);
    expect(result.ok).toBe(false);
    expect(result.blockingFindings.some((f) => f.layer === 'secrets')).toBe(true);
  });

  it('does NOT refuse on only non-blocking Layer-3 normalization findings', () => {
    const record = exportSession(normalizationOnlySession(), OPTS);
    const result = precheckRecord(record.jsonl, OPTS);
    expect(result.ok).toBe(true);
    // There ARE findings, but every one is non-blocking (L3 statistics).
    expect(result.report.findings.length).toBeGreaterThan(0);
    expect(result.blockingFindings).toHaveLength(0);
  });

  it('surfaces the engine + ruleset version it used, for CI parity', () => {
    const record = exportSession(cleanSession(), OPTS);
    const result = precheckRecord(record.jsonl, OPTS);
    expect(result.engine).toEqual({
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      rulesetVersion: RULESET_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
  });
});

describe('raw-bytes backstop — secrets in fields the structured scan never visits (B1)', () => {
  // Message content is CLEAN in every case; the secret is planted only in a field
  // outside collectScanUnits' reach. Before the backstop each of these passed
  // precheck AND CI (PoC in the review report). Now each must refuse.
  const cleanBody = [makeMessage({ role: 'assistant', content: 'The refactor is complete.' })];

  it('refuses a secret planted in meta.contributorAlias', () => {
    const s = makeStampedSession(cleanBody, { contributorAlias: `alias-${FAKE_GITHUB_PAT}` });
    expect(precheckRecord(s, OPTS).ok).toBe(false);
  });

  it('refuses a secret planted in meta.toolVersion', () => {
    const s = makeStampedSession(cleanBody, { toolVersion: `0.1.0-${FAKE_GITHUB_PAT}` });
    expect(precheckRecord(s, OPTS).ok).toBe(false);
  });

  it('refuses a secret planted in session.projectKey', () => {
    const s = makeStampedSession(cleanBody, { projectKey: `proj-${FAKE_AWS_KEY}` });
    expect(precheckRecord(s, OPTS).ok).toBe(false);
  });

  it('refuses a secret planted in schemaVersion', () => {
    const s = makeStampedSession(cleanBody, { schemaVersion: `0.1.0-${FAKE_GITHUB_PAT}` });
    expect(precheckRecord(s, OPTS).ok).toBe(false);
  });

  it('refuses a secret planted in session.sourceId', () => {
    const s = makeStampedSession(cleanBody, { sourceId: `src-${FAKE_AWS_KEY}` });
    expect(precheckRecord(s, OPTS).ok).toBe(false);
  });

  it('the whole publish path refuses a meta-field secret (export → assertPrecheckClean throws)', () => {
    // exportSession does not normalize meta.toolVersion, so the serialized bytes
    // still carry the secret; the pre-check on those bytes must hard-refuse.
    const s = makeStampedSession(cleanBody, { toolVersion: `0.1.0-${FAKE_GITHUB_PAT}` });
    const record = exportSession(s, OPTS);
    expect(record.jsonl).toContain(FAKE_GITHUB_PAT);
    expect(() => assertPrecheckClean(record.jsonl, OPTS)).toThrow(PublishRefusedError);
  });

  it('does NOT false-positive on a realistic clean session (UUID id + real-looking path)', () => {
    const s = makeStampedSession(
      [makeMessage({ role: 'user', content: 'Run the tests, please.' })],
      {
        sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        sourceId: 'claude-code',
        projectKey: '-home-user-code-proj',
        cwd: '/home/user/code/proj',
      },
    );
    const result = precheckRecord(s, OPTS);
    expect(result.ok).toBe(true);
    expect(result.blockingFindings).toHaveLength(0);
  });
});
