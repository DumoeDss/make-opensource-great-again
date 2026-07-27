import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import { describe, expect, it, vi } from 'vitest';

import {
  CONTRIBUTION_BUNDLE_CONTRACT_VERSION,
  CONTRIBUTION_BUNDLE_MAX_RECORDS,
  ContributionBundleRefusedError,
  compileContributionBundle,
  computeContributionContentDigest,
  exportSession,
} from '../index.js';
import {
  assertDataRepoPath,
  assertSupportedGitBranch,
} from '../path-safety.js';
import {
  FAKE_GITHUB_PAT,
  GITLEAKS_PIN,
  RULESET,
  RULESET_VERSION,
  SANITIZER_PACKAGE_VERSION,
  cleanSession,
  makeMessage,
  makeStampedSession,
} from './_fixtures.js';

const OPTIONS = {
  ruleset: RULESET,
  sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
  gitleaksVersion: GITLEAKS_PIN,
  generatedAt: '2026-07-27T00:00:00.000Z',
  license: 'CC-BY-4.0',
};
const require = createRequire(import.meta.url);

function cleanWith(sessionId: string, content = `clean content for ${sessionId}`) {
  return makeStampedSession(
    [
      makeMessage({ role: 'user', content }),
      makeMessage({ role: 'assistant', content: `completed ${sessionId}` }),
    ],
    { sessionId },
  );
}

function leaking(sessionId: string) {
  return makeStampedSession(
    [makeMessage({ role: 'assistant', content: `fake canary ${FAKE_GITHUB_PAT}` })],
    { sessionId },
  );
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

describe('compileContributionBundle collection contract', () => {
  it('uses one contract shape and pipeline for N=1 and N>1', () => {
    const single = compileContributionBundle([cleanWith('solo')], OPTIONS);
    const batch = compileContributionBundle([cleanWith('a'), cleanWith('b')], OPTIONS);

    expect(Object.keys(single)).toEqual(Object.keys(batch));
    expect(single.contractVersion).toBe(CONTRIBUTION_BUNDLE_CONTRACT_VERSION);
    expect(single.recordCount).toBe(1);
    expect(single.files).toHaveLength(2);
    expect(single.branch).toMatch(/^contrib\/%3CUSERNAME_1%3E\/solo-[0-9a-f]{8}$/);
    expect(batch.recordCount).toBe(2);
    expect(batch.files).toHaveLength(4);
    expect(batch.branch).toMatch(/^contrib\/%3CUSERNAME_1%3E\/batch-[0-9a-f]{8}$/);
  });

  it('deep-equals for the same logical session set in any input order', () => {
    const alpha = cleanWith('alpha');
    const zulu = cleanWith('zulu');

    const forward = compileContributionBundle([alpha, zulu], OPTIONS);
    const reverse = compileContributionBundle([zulu, alpha], OPTIONS);

    expect(reverse).toEqual(forward);
    expect(forward.records.map((record) => record.sessionId)).toEqual(['alpha', 'zulu']);
    expect(forward.files.map((file) => file.path)).toEqual(
      [...forward.files.map((file) => file.path)].sort(),
    );
    expect(forward.prBody.indexOf('`alpha`')).toBeLessThan(forward.prBody.indexOf('`zulu`'));
  });

  it('refuses empty/oversized collections, alias mismatch, and duplicate raw IDs', () => {
    expect(() => compileContributionBundle([], OPTIONS)).toThrow(/at least one/);
    expect(() =>
      compileContributionBundle(
        Array.from({ length: CONTRIBUTION_BUNDLE_MAX_RECORDS + 1 }, () => cleanSession()),
        OPTIONS,
      ),
    ).toThrow(/at most 500/);

    const aliasA = cleanWith('a');
    const aliasB = makeStampedSession([makeMessage({ content: 'clean' })], {
      sessionId: 'b',
      contributorAlias: '<USERNAME_2>',
    });
    expect(() => compileContributionBundle([aliasA, aliasB], OPTIONS)).toThrow(
      /one exact contributorAlias/,
    );
    expect(() =>
      compileContributionBundle([cleanWith('duplicate'), cleanWith('duplicate')], OPTIONS),
    ).toThrow(/duplicate raw sessionId/);
  });

  it('rejects lossy unsafe IDs rather than remapping them into colliding paths', () => {
    const slash = cleanWith('slug/value');
    const question = cleanWith('slug?value');
    expect(() => compileContributionBundle([slash, question], OPTIONS)).toThrow(
      /unsafe sessionId/,
    );
  });

  it.each([
    ['schemaVersion', '.', { schemaVersion: '.' }],
    ['schemaVersion', '..', { schemaVersion: '..' }],
    ['schemaVersion', '/absolute', { schemaVersion: '/absolute' }],
    ['schemaVersion', 'a\\b', { schemaVersion: 'a\\b' }],
    ['schemaVersion', 'a..b', { schemaVersion: 'a..b' }],
    ['contributorAlias', '.hidden', { contributorAlias: '.hidden' }],
    ['contributorAlias', 'x.lock', { contributorAlias: 'x.lock' }],
    ['contributorAlias', 'trailing.', { contributorAlias: 'trailing.' }],
    ['contributorAlias', 'bad~ref', { contributorAlias: 'bad~ref' }],
    ['sessionId', 'C:\\absolute', { sessionId: 'C:\\absolute' }],
    ['sessionId', 'bad\u0000id', { sessionId: 'bad\u0000id' }],
    ['sessionId', 'bad@{ref', { sessionId: 'bad@{ref' }],
    ['sessionId', 'bad ref', { sessionId: 'bad ref' }],
  ])('rejects unsafe %s component %j', (label, _value, overrides) => {
    const session = makeStampedSession([makeMessage({ content: 'clean' })], overrides);
    expect(() => compileContributionBundle([session], OPTIONS)).toThrow(
      new RegExp(`unsafe ${label}`),
    );
  });

  it.each([
    ['lone high surrogate U+D800', '\uD800'],
    ['distinct lone high surrogate U+D801', '\uD801'],
    ['lone low surrogate', '\uDC00'],
    ['high surrogate followed by a non-low surrogate', '\uD800x'],
    ['low surrogate before a high surrogate', '\uDC00\uD800'],
  ])('rejects an ill-formed sessionId containing %s', (_description, sessionId) => {
    const session = makeStampedSession([makeMessage({ content: 'clean' })], { sessionId });
    expect(() => compileContributionBundle([session], OPTIONS)).toThrow(
      /unsafe sessionId.*ill-formed UTF-16/,
    );
  });

  it.each([
    ['schemaVersion', { schemaVersion: '\uD800' }],
    ['contributorAlias', { contributorAlias: '\uD800' }],
    ['sessionId', { sessionId: '\uD800' }],
  ])('validates well-formed UTF-16 for every encoded %s segment', (label, overrides) => {
    const session = makeStampedSession([makeMessage({ content: 'clean' })], overrides);
    expect(() => compileContributionBundle([session], OPTIONS)).toThrow(
      new RegExp(`unsafe ${label}.*ill-formed UTF-16`),
    );
  });

  it('preserves distinct deterministic encodings for accepted Unicode and percent inputs', () => {
    const cases = [
      ['emoji', '😀', '%F0%9F%98%80'],
      ['replacement character', '\uFFFD', '%EF%BF%BD'],
      ['composed Unicode', '\u00E9', '%C3%A9'],
      ['decomposed Unicode', 'e\u0301', 'e%CC%81'],
      ['percent', '%', '%25'],
      ['percent-looking separator', '%2F', '%252F'],
    ] as const;
    const paths = cases.map(([_description, sessionId, encoded]) => {
      const session = cleanWith(sessionId);
      const first = compileContributionBundle([session], OPTIONS);
      const second = compileContributionBundle([session], OPTIONS);
      const recordPath = first.files.find((file) => file.kind === 'record')!.path;

      expect(second).toEqual(first);
      expect(recordPath).toBe(`data/0.1.0/%3CUSERNAME_1%3E/${encoded}.jsonl`);
      return recordPath;
    });

    expect(new Set(paths).size).toBe(cases.length);
  });

  it('emits only contained POSIX data paths and a supported in-memory Git branch', () => {
    const bundle = compileContributionBundle(
      [
        makeStampedSession([makeMessage({ content: 'clean-a' })], {
          sessionId: 'alpha-é',
          contributorAlias: '<USERNAME_1>',
        }),
        cleanWith('zulu'),
      ],
      OPTIONS,
    );

    expect(bundle.files.every((file) => file.path.startsWith('data/'))).toBe(true);
    expect(bundle.files.every((file) => !file.path.includes('\\'))).toBe(true);
    for (const file of bundle.files) {
      expect(() => assertDataRepoPath(file.path)).not.toThrow();
    }
    expect(() => assertSupportedGitBranch(bundle.branch)).not.toThrow();
  });

  it('binds the branch to changed exact content, not only the session ID', () => {
    const first = compileContributionBundle([cleanWith('stable-id', 'first clean body')], OPTIONS);
    const changed = compileContributionBundle(
      [cleanWith('stable-id', 'changed clean body')],
      OPTIONS,
    );

    expect(changed.contentDigest).not.toBe(first.contentDigest);
    expect(changed.branch).not.toBe(first.branch);
  });

  it('renders deterministic single/batch metadata with provenance and consent', () => {
    const first = compileContributionBundle([cleanWith('b'), cleanWith('a')], OPTIONS);
    const second = compileContributionBundle([cleanWith('b'), cleanWith('a')], OPTIONS);

    expect(second.prTitle).toBe(first.prTitle);
    expect(second.prBody).toBe(first.prBody);
    expect(first.prTitle).toBe('Add 2 sanitized sessions (<USERNAME_1>)');
    expect(first.commitMessage).toContain('records: 2');
    expect(first.prBody).toContain(RULESET_VERSION);
    expect(first.prBody).toContain(`@mosga/sanitizer@${SANITIZER_PACKAGE_VERSION}`);
    expect(first.prBody).toContain(GITLEAKS_PIN);
    expect(first.prBody).toContain('Sanitization attestation');
    expect(first.prBody).toContain('Contributor consent');
    expect(first.prBody).not.toContain('2026-07-27');
  });
});

describe('exact bytes, hashes, and contract-v1 digest', () => {
  it('returns exact record/sidecar contents with UTF-8 byte/hash totals', () => {
    const session = makeStampedSession(
      [makeMessage({ role: 'assistant', content: '多字节 clean value' })],
      { sessionId: 'unicode' },
    );
    const bundle = compileContributionBundle([session], OPTIONS);
    const exported = exportSession(session, {
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
    const record = bundle.files.find((file) => file.kind === 'record')!;
    const provenance = bundle.files.find((file) => file.kind === 'provenance')!;

    expect(record.contents).toBe(exported.fileContents);
    expect(record.contents.endsWith('\n')).toBe(true);
    expect(record.bytes).toBe(Buffer.byteLength(record.contents, 'utf8'));
    expect(record.bytes).toBeGreaterThan(record.contents.length);
    expect(record.contentHash).toBe(sha256(record.contents));
    expect(provenance.contents).toBe(`${JSON.stringify(exported.provenance, null, 2)}\n`);
    expect(provenance.bytes).toBe(Buffer.byteLength(provenance.contents, 'utf8'));
    expect(provenance.contentHash).toBe(sha256(provenance.contents));
    expect(bundle.totalBytes).toBe(record.bytes + provenance.bytes);
    expect(bundle.engine).toEqual({
      sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
      rulesetVersion: RULESET_VERSION,
      gitleaksVersion: GITLEAKS_PIN,
    });
  });

  it('matches fixed manifest digest vectors, including multibyte UTF-8 content', () => {
    expect(computeContributionContentDigest([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );

    const unicodeContents = '雪\n';
    expect(Buffer.byteLength(unicodeContents, 'utf8')).toBe(4);
    expect(sha256(unicodeContents)).toBe(
      'fa717a4768de2a0256209be52fe7fd5c9d100983d5454023aca1fec35b92e731',
    );
    expect(
      computeContributionContentDigest([
        {
          path: 'data/é.txt',
          bytes: 4,
          contentHash: 'fa717a4768de2a0256209be52fe7fd5c9d100983d5454023aca1fec35b92e731',
        },
      ]),
    ).toBe('b6d360c3239079110b1ae983f8527f53f741980981896c3755100be9d6ebeff9');
  });

  it('computes the bundle digest from the path-sorted canonical manifest', () => {
    const bundle = compileContributionBundle([cleanWith('z'), cleanWith('a')], OPTIONS);
    const manifestJson = JSON.stringify(
      bundle.files.map(({ path, bytes, contentHash }) => ({ path, bytes, contentHash })),
    );
    expect(bundle.contentDigest).toBe(sha256(manifestJson));
    expect(bundle.branch.endsWith(bundle.contentDigest.slice(0, 8))).toBe(true);
  });
});

describe('mandatory final-byte refusal boundary', () => {
  it('prechecks the literal trailing newline of every record file', () => {
    expect(() =>
      compileContributionBundle([cleanWith('newline-proof')], {
        ...OPTIONS,
        ruleset: undefined,
        customRules: [{ id: 'final-newline', kind: 'literal', pattern: '\n' }],
      }),
    ).toThrow(ContributionBundleRefusedError);

    try {
      compileContributionBundle([cleanWith('newline-proof')], {
        ...OPTIONS,
        ruleset: undefined,
        customRules: [{ id: 'final-newline', kind: 'literal', pattern: '\n' }],
      });
    } catch (error) {
      expect((error as ContributionBundleRefusedError).refusals).toEqual([
        { sessionId: 'newline-proof', blockingByRule: { 'final-newline': 1 } },
      ]);
    }
  });

  it('aggregates all refused sessions as deterministic rule counts only', () => {
    let thrown: unknown;
    try {
      compileContributionBundle(
        [leaking('leak-z'), cleanWith('clean'), leaking('leak-a')],
        OPTIONS,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContributionBundleRefusedError);
    const refusal = thrown as ContributionBundleRefusedError;
    expect(refusal.refusals.map((entry) => entry.sessionId)).toEqual(['leak-a', 'leak-z']);
    for (const entry of refusal.refusals) {
      expect(Object.keys(entry)).toEqual(['sessionId', 'blockingByRule']);
      expect(Object.keys(entry.blockingByRule)).toEqual(
        [...Object.keys(entry.blockingByRule)].sort(),
      );
      expect(Object.values(entry.blockingByRule).every((count) => count > 0)).toBe(true);
    }
    expect(JSON.stringify(refusal)).not.toContain(FAKE_GITHUB_PAT);
    expect(refusal).not.toHaveProperty('blockingFindings');
  });

  it('has no filesystem, process, network, workspace, or GitHub operation', () => {
    const runtimeFs = require('node:fs') as typeof import('node:fs');
    const runtimeChildProcess =
      require('node:child_process') as typeof import('node:child_process');
    const runtimeHttp = require('node:http') as typeof import('node:http');
    const runtimeHttps = require('node:https') as typeof import('node:https');
    const runtimeNet = require('node:net') as typeof import('node:net');
    const existsSpy = vi.spyOn(runtimeFs, 'existsSync');
    const readSpy = vi.spyOn(runtimeFs, 'readFileSync');
    const writeSpy = vi.spyOn(runtimeFs, 'writeFileSync');
    const spawnSpy = vi.spyOn(runtimeChildProcess, 'spawn');
    const spawnSyncSpy = vi.spyOn(runtimeChildProcess, 'spawnSync');
    const execSpy = vi.spyOn(runtimeChildProcess, 'exec');
    const execSyncSpy = vi.spyOn(runtimeChildProcess, 'execSync');
    const execFileSpy = vi.spyOn(runtimeChildProcess, 'execFile');
    const execFileSyncSpy = vi.spyOn(runtimeChildProcess, 'execFileSync');
    const forkSpy = vi.spyOn(runtimeChildProcess, 'fork');
    const httpRequestSpy = vi.spyOn(runtimeHttp, 'request');
    const httpsRequestSpy = vi.spyOn(runtimeHttps, 'request');
    const netConnectSpy = vi.spyOn(runtimeNet, 'connect');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not be called'));
    syncBuiltinESMExports();

    try {
      const bundle = compileContributionBundle([cleanWith('pure-default')]);

      expect(existsSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(execFileSyncSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
      expect(httpRequestSpy).not.toHaveBeenCalled();
      expect(httpsRequestSpy).not.toHaveBeenCalled();
      expect(netConnectSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(bundle).not.toHaveProperty('workspace');
      expect(bundle).not.toHaveProperty('targetRepo');
      expect(bundle).not.toHaveProperty('commands');
      expect(bundle).not.toHaveProperty('ghAvailable');
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });
});
