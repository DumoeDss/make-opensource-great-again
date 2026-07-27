import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { SanitizedSession } from '@mosga/contracts';
import {
  compileContributionBundle,
} from '@mosga/publisher';
import {
  compileRuleset,
} from '@mosga/sanitizer';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FilePublicationJournalStore,
  FilePublicationLock,
  FilePublicationReceiptStore,
  FilePublicationTargetStore,
  InMemoryPublicationJournalStore,
  InMemoryPublicationReceiptStore,
  InMemoryPublicationTargetStore,
  InMemorySealedPreviewStore,
  PublicationError,
  assertManifestAccepts,
  parseCanonicalRepository,
  parseDatasetManifest,
  type PublicationJournal,
  type PublicationReceipt,
  type SealedPublication,
  type StoredPublicationTarget,
} from '../publication/index.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'mosga-publication-foundation-'));
  tempRoots.push(value);
  return value;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical publication target and manifest', () => {
  it('accepts only strict canonical owner/repo inputs', () => {
    expect(parseCanonicalRepository('Mosga-Org/community.data')).toEqual({
      owner: 'Mosga-Org',
      repo: 'community.data',
      slug: 'Mosga-Org/community.data',
    });
    const invalid = [
      '',
      ' owner/repo',
      'owner/repo ',
      'owner',
      'owner/repo/extra',
      'owner//repo',
      './repo',
      '../repo',
      'owner/..',
      'owner/repo.git',
      'owner/re po',
      'https://github.com/owner/repo',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo',
      'https://token@github.com/owner/repo',
      'gitlab.com/owner/repo',
      'C:\\repo',
      '/tmp/repo',
      'owner/repo?branch=main',
      'owner/repo#main',
      'owner/repo\n',
    ];
    for (const value of invalid) {
      expect(() => parseCanonicalRepository(value), value).toThrowError(
        expect.objectContaining({
          body: expect.objectContaining({ code: 'invalid_target' }),
        }),
      );
    }
  });

  it('strictly validates compatibility and schema acceptance', () => {
    const manifest = parseDatasetManifest(
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0', '0.2.0'],
        license: 'CC-BY-4.0',
      }),
    );
    expect(manifest.license).toBe('CC-BY-4.0');
    expect(() => assertManifestAccepts(manifest, ['0.2.0'])).not.toThrow();
    expect(() => assertManifestAccepts(manifest, ['9.0.0'])).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({ code: 'target_incompatible' }),
      }),
    );

    const invalid = [
      '',
      '{',
      '{}',
      JSON.stringify({
        kind: 'other',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0'],
        license: 'CC-BY-4.0',
      }),
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 2,
        acceptedSchemaVersions: ['0.1.0'],
        license: 'CC-BY-4.0',
      }),
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: [],
        license: 'CC-BY-4.0',
      }),
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0', '0.1.0'],
        license: 'CC-BY-4.0',
      }),
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0'],
        license: 'TBD',
      }),
      JSON.stringify({
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0'],
        license: 'CC-BY-4.0',
        authority: 'unexpected',
      }),
    ];
    for (const value of invalid) {
      expect(() => parseDatasetManifest(value), value).toThrowError(
        expect.objectContaining({
          body: expect.objectContaining({ code: 'target_incompatible' }),
        }),
      );
    }
  });
});

describe('publication target stores', () => {
  it('persists restart state with monotonic and idempotent revisions', async () => {
    const file = path.join(tempRoot(), 'private', 'target.json');
    const first = new FilePublicationTargetStore(file);
    expect(await first.read()).toEqual({
      schemaVersion: 1,
      revision: 0,
      upstream: null,
    });
    expect((await first.configure({ owner: 'owner', repo: 'repo' })).revision).toBe(1);
    expect((await first.configure({ owner: 'owner', repo: 'repo' })).revision).toBe(1);

    const restarted = new FilePublicationTargetStore(file);
    expect((await restarted.read()).upstream).toEqual({ owner: 'owner', repo: 'repo' });
    expect((await restarted.clear()).revision).toBe(2);
    expect((await restarted.clear()).revision).toBe(2);
    expect((await restarted.configure({ owner: 'owner', repo: 'repo' })).revision).toBe(3);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([
      'target.json',
      'target.json.lock',
    ]);
    expect(fs.readdirSync(`${file}.lock`)).toEqual([]);
  });

  it('has identical in-memory semantics and fail-closes corrupt files', async () => {
    const memory = new InMemoryPublicationTargetStore();
    expect((await memory.clear()).revision).toBe(0);
    expect((await memory.configure({ owner: 'a', repo: 'b' })).revision).toBe(1);
    expect((await memory.configure({ owner: 'a', repo: 'b' })).revision).toBe(1);
    expect((await memory.clear()).revision).toBe(2);

    const file = path.join(tempRoot(), 'target.json');
    fs.writeFileSync(file, '{"schemaVersion":1', 'utf8');
    await expect(new FilePublicationTargetStore(file).read()).rejects.toMatchObject({
      body: {
        code: 'target_store_unavailable',
        message: 'Publication target configuration is unavailable.',
      },
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        upstream: { owner: '..', repo: 'escape' },
      }),
      'utf8',
    );
    await expect(new FilePublicationTargetStore(file).read()).rejects.toMatchObject({
      body: { code: 'target_store_unavailable' },
    });
  });

  it('serializes concurrent target mutations across file-store instances', async () => {
    const file = path.join(tempRoot(), 'shared', 'target.json');
    const first = new FilePublicationTargetStore(file);
    const second = new FilePublicationTargetStore(file);
    const configured = await Promise.all([
      first.configure({ owner: 'alpha', repo: 'dataset' }),
      second.configure({ owner: 'beta', repo: 'dataset' }),
    ]);
    expect(configured.map((value) => value.revision).sort()).toEqual([1, 2]);
    expect((await first.read()).revision).toBe(2);

    const mixed = await Promise.all([
      first.configure({ owner: 'gamma', repo: 'dataset' }),
      second.clear(),
    ]);
    expect(mixed.map((value) => value.revision).sort()).toEqual([3, 4]);
    const final = await second.read();
    expect(final.revision).toBe(4);
    expect(
      final.upstream === null ||
        (final.upstream.owner === 'gamma' &&
          final.upstream.repo === 'dataset'),
    ).toBe(true);
    expect(fs.readdirSync(`${file}.lock`)).toEqual([]);
  });

  it('sanitizes write failures and never includes local paths', async () => {
    const secretPath = path.join(tempRoot(), 'do-not-leak', 'target.json');
    const store = new FilePublicationTargetStore(secretPath, {
      readFile: async () => {
        const error = new Error(secretPath) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      mkdir: async () => undefined,
      writeFile: async () => {
        throw new Error(`token ghp_FAKE ${secretPath}`);
      },
      rename: async () => undefined,
      unlink: async () => undefined,
    });
    const error = await store
      .configure({ owner: 'owner', repo: 'repo' })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PublicationError);
    expect(JSON.stringify((error as PublicationError).body)).not.toContain(secretPath);
    expect(JSON.stringify((error as PublicationError).body)).not.toContain('ghp_FAKE');
  });
});

function fakeSeal(
  revision: number,
): Omit<SealedPublication, 'publicationRef' | 'createdAt' | 'expiresAt'> {
  const generatedAt = '2026-07-27T00:00:00.000Z';
  const ruleset = compileRuleset({ generatedAt });
  const session: SanitizedSession = {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'codex',
      toolVersion: '1.0.0',
      sanitizationRulesetVersion: ruleset.rulesetVersion,
      exportedAt: generatedAt,
      license: 'CC-BY-4.0',
      sanitized: true,
    },
    session: {
      sessionId: 'session',
      sourceId: 'session',
      projectKey: 'project',
      cwd: null,
      title: null,
      updatedAt: 1,
    },
    messages: [
      {
        sdkUuid: 'message-session',
        parentUuid: null,
        role: 'user',
        content: 'private but sanitized test content',
        sdkMessageType: 'message',
        timestamp: 1,
      },
    ],
  };
  const compilerOptions = {
    ruleset,
    generatedAt,
    sanitizerPackageVersion: '0.1.0',
    gitleaksVersion: ruleset.gitleaksVersion,
    license: 'CC-BY-4.0',
  };
  const bundle = compileContributionBundle([session], compilerOptions);
  const manifestContents = JSON.stringify({
    kind: 'mosga-community-data',
    contractVersion: 1,
    acceptedSchemaVersions: ['0.1.0'],
    license: 'CC-BY-4.0',
  });
  return {
    reviewIds: ['review'],
    reviewSessionIds: { review: 'session' },
    target: {
      revision,
      repositoryId: 'R_1',
      upstream: 'owner/repo',
      upstreamUrl: 'https://github.com/owner/repo',
      actor: 'actor',
      route: 'direct',
      pushRepository: 'owner/repo',
      forkProvision: 'none',
      defaultBranch: 'main',
      baseCommitSha: 'c'.repeat(40),
      manifestContentHash: 'd'.repeat(64),
      manifestContents,
      manifest: {
        kind: 'mosga-community-data',
        contractVersion: 1,
        acceptedSchemaVersions: ['0.1.0'],
        license: 'CC-BY-4.0',
      },
    },
    bundle,
    compilerOptions,
    ruleset,
  };
}

describe('sealed preview store', () => {
  it('enforces exact TTL boundaries and excludes exact contents publicly', () => {
    let now = new Date('2026-07-27T00:00:00.000Z');
    let counter = 0;
    const store = new InMemorySealedPreviewStore({
      now: () => now,
      id: () => `publication_${++counter}`,
      ttlMs: 1_000,
    });
    const seal = store.put(fakeSeal(1));
    const publicPreview = store.project(store.get(seal.publicationRef));
    expect(publicPreview.publicationRef).toBe('publication_1');
    expect(JSON.stringify(publicPreview)).not.toContain('private');
    expect(JSON.stringify(publicPreview)).not.toContain('contents');
    expect(seal.bundle.files[0].contents).toContain('private');

    now = new Date('2026-07-27T00:00:00.999Z');
    expect(store.get(seal.publicationRef).publicationRef).toBe(seal.publicationRef);
    now = new Date('2026-07-27T00:00:01.000Z');
    expect(() => store.get(seal.publicationRef)).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({ code: 'preview_expired' }),
      }),
    );
  });

  it('evicts oldest seals, invalidates changed targets, and loses seals on restart', () => {
    let counter = 0;
    const store = new InMemorySealedPreviewStore({
      id: () => `p_${++counter}`,
      capacity: 2,
    });
    const first = store.put(fakeSeal(1));
    const second = store.put(fakeSeal(2));
    const third = store.put(fakeSeal(2));
    expect(() => store.get(first.publicationRef)).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({ code: 'preview_not_found' }),
      }),
    );
    store.invalidateTargetRevision(2);
    expect(() => store.get(second.publicationRef)).toThrow();
    expect(() => store.get(third.publicationRef)).toThrow();
    expect(() => new InMemorySealedPreviewStore().get('lost-after-restart')).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({ code: 'preview_not_found' }),
      }),
    );
  });
});

function receipt(publicationRef = 'publication_1'): PublicationReceipt {
  return {
    publicationRef,
    targetRevision: 1,
    upstream: 'owner/repo',
    pushRepository: 'owner/repo',
    mode: 'direct',
    baseBranch: 'main',
    baseCommitSha: 'a'.repeat(40),
    branch: 'contrib/alias/session-aaaaaaaa',
    commitSha: 'b'.repeat(40),
    prNumber: 1,
    prUrl: 'https://github.com/owner/repo/pull/1',
    recordCount: 1,
    contentDigest: 'c'.repeat(64),
    submittedAt: '2026-07-27T00:00:00.000Z',
  };
}

function journal(
  phase: PublicationJournal['phase'],
  publicationRef = 'publication_1',
): PublicationJournal {
  const seal: SealedPublication = {
    ...fakeSeal(1),
    publicationRef,
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T00:15:00.000Z',
  };
  const value: PublicationJournal = {
    schemaVersion: 1,
    publicationRef,
    targetRevision: 1,
    contentDigest: seal.bundle.contentDigest,
    phase,
    upstream: 'owner/repo',
    pushRepository: 'owner/repo',
    mode: 'direct',
    baseBranch: 'main',
    baseCommitSha: seal.target.baseCommitSha,
    branch: seal.bundle.branch,
    repositoryId: 'R_1',
    seal,
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
  if (phase !== 'validated') {
    value.commitSha = 'b'.repeat(40);
    value.treeSha = 'd'.repeat(40);
  }
  if (phase === 'pr_observed' || phase === 'completed') {
    value.prNumber = 1;
    value.prUrl = 'https://github.com/owner/repo/pull/1';
  }
  if (phase === 'completed') {
    value.receipt = {
      ...receipt(publicationRef),
      branch: value.branch,
      baseCommitSha: value.baseCommitSha,
      commitSha: value.commitSha as string,
      contentDigest: value.contentDigest,
      recordCount: seal.bundle.recordCount,
    };
  }
  return value;
}

describe('journal, receipt, and publication lock', () => {
  it('enforces monotonic journals and immutable idempotent receipts in memory', async () => {
    const journals = new InMemoryPublicationJournalStore();
    const validated = journal('validated');
    expect(await journals.write(validated)).toEqual(validated);
    expect(await journals.write(validated)).toEqual(validated);
    await expect(journals.write(journal('pushed'))).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    expect((await journals.write(journal('committed'))).phase).toBe('committed');
    await expect(journals.write(journal('validated'))).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });

    const receipts = new InMemoryPublicationReceiptStore();
    const original = receipt();
    expect(await receipts.write(original)).toEqual(original);
    expect(await receipts.write(original)).toEqual(original);
    await expect(
      receipts.write({ ...original, prNumber: 2 }),
    ).rejects.toMatchObject({ body: { code: 'workspace_unavailable' } });
  });

  it('persists atomically, fails closed on truncation, and exposes safe reads', async () => {
    const root = tempRoot();
    const journals = new FilePublicationJournalStore(path.join(root, 'journals'));
    const receipts = new FilePublicationReceiptStore(path.join(root, 'receipts'));
    await journals.write(journal('validated'));
    await journals.write(journal('committed'));
    await receipts.write(receipt());
    expect((await new FilePublicationJournalStore(path.join(root, 'journals')).read('publication_1'))?.phase)
      .toBe('committed');
    expect(
      await new FilePublicationReceiptStore(path.join(root, 'receipts')).read('publication_1'),
    ).toEqual(receipt());

    fs.writeFileSync(
      path.join(root, 'journals', 'publication_corrupt.json'),
      '{"schemaVersion":1',
      'utf8',
    );
    await expect(journals.read('publication_corrupt')).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
    expect(JSON.stringify(await receipts.read('publication_1'))).not.toContain(root);
    expect(JSON.stringify(await receipts.read('publication_1'))).not.toContain('token');
    fs.writeFileSync(
      path.join(root, 'receipts', 'publication_corrupt.json'),
      JSON.stringify(receipt('publication_corrupt')),
      'utf8',
    );
    await expect(receipts.read('publication_corrupt')).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
  });

  it('binds durable lookup keys and rejects phase-incomplete journals', async () => {
    const root = tempRoot();
    const journalDirectory = path.join(root, 'journals');
    const receiptDirectory = path.join(root, 'receipts');
    const journals = new FilePublicationJournalStore(journalDirectory);
    const receipts = new FilePublicationReceiptStore(receiptDirectory);

    await journals.write(journal('validated', 'publication_A'));
    await journals.write(journal('validated', 'publication_B'));
    fs.copyFileSync(
      path.join(journalDirectory, 'publication_B.json'),
      path.join(journalDirectory, 'publication_A.json'),
    );
    await expect(journals.read('publication_A')).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });

    await receipts.write(receipt('publication_A'));
    await receipts.write(receipt('publication_B'));
    fs.copyFileSync(
      path.join(receiptDirectory, 'publication_B.json'),
      path.join(receiptDirectory, 'publication_A.json'),
    );
    await expect(receipts.read('publication_A')).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });

    const corrupt = journal('pushed', 'publication_phase_corrupt');
    delete corrupt.treeSha;
    fs.writeFileSync(
      path.join(journalDirectory, 'publication_phase_corrupt.json'),
      `${JSON.stringify(corrupt)}\n`,
      'utf8',
    );
    await expect(
      journals.read('publication_phase_corrupt'),
    ).rejects.toMatchObject({
      body: { code: 'workspace_unavailable' },
    });
  });

  it('rejects a cross-instance concurrent publication lock', async () => {
    const lockPath = path.join(tempRoot(), 'runtime', 'publication.lock');
    const first = new FilePublicationLock(lockPath);
    const second = new FilePublicationLock(lockPath);
    let release!: () => void;
    const held = first.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    while (!release) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await expect(second.run(async () => undefined)).rejects.toMatchObject({
      body: { code: 'publish_in_flight' },
    });
    release();
    await held;
    await expect(second.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('reclaims a well-formed lock from a process that no longer exists', async () => {
    const lockPath = path.join(tempRoot(), 'runtime', 'publication.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'dead-owner.claim'),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        token: 'dead-owner',
      })}\n`,
      'utf8',
    );
    await expect(
      new FilePublicationLock(lockPath).run(async () => 'recovered'),
    ).resolves.toBe('recovered');
    expect(fs.readdirSync(lockPath)).toEqual([]);
  });
});
