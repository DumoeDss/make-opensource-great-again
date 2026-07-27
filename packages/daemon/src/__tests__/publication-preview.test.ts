import fs from 'node:fs';

import type { SanitizedSession } from '@mosga/contracts';
import {
  compileContributionBundle,
  type ContributionBundle,
} from '@mosga/publisher';
import { compileRuleset } from '@mosga/sanitizer';
import { describe, expect, it, vi } from 'vitest';

import { ReviewStore } from '../reviews.js';
import {
  GitHubAdapterError,
  GitHubPublicationService,
  InMemoryPublicationTargetStore,
  InMemorySealedPreviewStore,
  RecordingGitHubPort,
  canonicalPortablePath,
  sameBundleCommitments,
  selectPublicationReviews,
  validateContributionBundle,
  type SealedPreviewStore,
} from '../publication/index.js';
import { FAKE_AWS_KEY } from './_helpers.js';

function session(id: string, text = 'a clean contribution'): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: '1.0.0',
      sanitizationRulesetVersion: 'reviewed-rules',
      exportedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
      sanitized: true,
    },
    session: {
      sessionId: id,
      sourceId: `source-${id}`,
      projectKey: 'project',
      cwd: null,
      title: null,
      updatedAt: 1,
    },
    messages: [
      {
        sdkUuid: `message-${id}`,
        parentUuid: null,
        role: 'user',
        content: text,
        sdkMessageType: 'message',
        timestamp: 1,
      },
    ],
  };
}

const ruleset = compileRuleset({ generatedAt: '2026-07-27T00:00:00.000Z' });

function reviewed(store: ReviewStore, value: SanitizedSession): string {
  return store.create(value, ruleset, {
    generatedAt: '2026-07-27T00:00:00.000Z',
  }).reviewId;
}

function validBundle(id = 'session'): ContributionBundle {
  return compileContributionBundle([session(id)], {
    generatedAt: '2026-07-27T00:00:00.000Z',
    license: 'CC-BY-4.0',
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('unified review selection', () => {
  it('validates bounds, deduplicates deterministically, and attributes missing/locked reviews', () => {
    const store = new ReviewStore();
    const first = reviewed(store, session('a'));
    const second = reviewed(store, session('b'));
    expect(
      selectPublicationReviews([first, second, first], store).map((item) => item.reviewId),
    ).toEqual([first, second]);

    for (const input of [[], Array.from({ length: 501 }, (_, i) => `r-${i}`), [''], [' x']]) {
      expect(() => selectPublicationReviews(input, store)).toThrowError(
        expect.objectContaining({
          body: expect.objectContaining({ code: 'review_not_found' }),
        }),
      );
    }
    expect(() => selectPublicationReviews([first, 'missing'], store)).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({
          code: 'review_not_found',
          reviewId: 'missing',
        }),
      }),
    );

    const locked = reviewed(store, session('locked', `secret ${FAKE_AWS_KEY}`));
    expect(() => selectPublicationReviews([locked], store)).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({ code: 'GATE_LOCKED', reviewId: locked }),
      }),
    );
  });
});

describe('independent contribution bundle validator', () => {
  it('accepts the reviewed Publisher contract and preserves Unicode/percent paths', () => {
    const bundle = validBundle('会话%2Fid');
    const paths = bundle.files.map((file) => file.path);
    expect(validateContributionBundle(bundle)).toBe(bundle);
    expect(paths.some((value) => value.includes('%252F'))).toBe(true);
    expect(bundle.files.map((file) => file.path)).toEqual(paths);
    expect(canonicalPortablePath(paths[0])).toContain('%25');
    expect(sameBundleCommitments(bundle, clone(bundle))).toBe(true);
  });

  it('refuses tampered bytes, hash, digest, totals, contents, records, order, and pins', () => {
    const mutations: Array<(bundle: ContributionBundle) => void> = [
      (bundle) => {
        bundle.files[0].contents += 'tampered';
      },
      (bundle) => {
        bundle.files[0].bytes += 1;
      },
      (bundle) => {
        bundle.files[0].contentHash = '0'.repeat(64);
      },
      (bundle) => {
        bundle.contentDigest = '0'.repeat(64);
      },
      (bundle) => {
        bundle.totalBytes += 1;
      },
      (bundle) => {
        bundle.recordCount += 1;
      },
      (bundle) => {
        bundle.records[0].recordPath = bundle.records[0].provenancePath;
      },
      (bundle) => {
        bundle.files.reverse();
      },
      (bundle) => {
        bundle.engine.rulesetVersion = '';
      },
      (bundle) => {
        bundle.branch = 'refs/heads/main';
      },
      (bundle) => {
        bundle.files[0].contents = '\ud800';
      },
    ];
    for (const mutate of mutations) {
      const bundle = clone(validBundle());
      mutate(bundle);
      expect(() => validateContributionBundle(bundle)).toThrowError(
        expect.objectContaining({
          body: expect.objectContaining({ code: 'preview_stale' }),
        }),
      );
    }
  });

  it('refuses traversal, controls, device names, backslashes, and case-fold collisions', () => {
    const unsafe = [
      '../escape.jsonl',
      'data/../escape.jsonl',
      'data\\escape.jsonl',
      'data/alias/CON.jsonl',
      'data/alias/file. ',
      'data/alias/bad\u0000name.jsonl',
      '/data/absolute.jsonl',
    ];
    for (const value of unsafe) {
      expect(() => canonicalPortablePath(value), value).toThrow();
    }

    const collision = clone(validBundle());
    collision.files[1].path = collision.files[0].path.toUpperCase();
    expect(() => validateContributionBundle(collision)).toThrow();

    const duplicateSession = clone(validBundle());
    duplicateSession.records.push(clone(duplicateSession.records[0]));
    duplicateSession.recordCount = 2;
    duplicateSession.files.push(...clone(duplicateSession.files));
    expect(() => validateContributionBundle(duplicateSession)).toThrow();
  });
});

describe('target status orchestration and sealed preview', () => {
  it('returns every discriminated status with safe issue projection', async () => {
    const store = new ReviewStore();
    const previews = new InMemorySealedPreviewStore();
    const unconfigured = new GitHubPublicationService({
      targetStore: new InMemoryPublicationTargetStore(),
      previews,
      github: new RecordingGitHubPort(),
      reviews: store,
      ruleset,
    });
    expect(await unconfigured.inspect()).toEqual({ state: 'unconfigured', revision: 0 });

    const directTarget = new InMemoryPublicationTargetStore();
    await directTarget.configure({ owner: 'owner', repo: 'repo' });
    const direct = new GitHubPublicationService({
      targetStore: directTarget,
      previews,
      github: new RecordingGitHubPort(),
      reviews: store,
      ruleset,
    });
    expect(await direct.inspect()).toMatchObject({
      state: 'ready',
      route: 'direct',
      pushRepository: 'owner/repo',
    });

    const confirmation = new GitHubPublicationService({
      targetStore: directTarget,
      previews,
      github: new RecordingGitHubPort({
        repository: {
          id: 'R_upstream',
          slug: 'owner/repo',
          url: 'https://github.com/owner/repo',
          visibility: 'public',
          defaultBranch: 'main',
          defaultHeadSha: 'a'.repeat(40),
          viewerPermission: 'READ',
        },
        fork: null,
      }),
      reviews: store,
      ruleset,
    });
    expect(await confirmation.inspect()).toMatchObject({
      state: 'fork_confirmation_required',
      pushRepository: 'actor/repo',
    });

    const login = new GitHubPublicationService({
      targetStore: directTarget,
      previews,
      github: new RecordingGitHubPort({
        actor: new GitHubAdapterError('login_required'),
      }),
      reviews: store,
      ruleset,
    });
    expect(await login.inspect()).toMatchObject({
      state: 'login_required',
      target: { slug: 'owner/repo' },
    });

    const blocked = new GitHubPublicationService({
      targetStore: directTarget,
      previews,
      github: new RecordingGitHubPort({
        repository: new GitHubAdapterError('not_found'),
      }),
      reviews: store,
      ruleset,
    });
    const status = await blocked.inspect();
    expect(status).toMatchObject({
      state: 'blocked',
      issues: [{ code: 'target_not_found', retryable: false }],
    });
    expect(JSON.stringify(status)).not.toContain('stderr');
    expect(JSON.stringify(status)).not.toContain('C:\\');
  });

  it('invalidates seals only on semantic target changes', async () => {
    const targetStore = new InMemoryPublicationTargetStore();
    const invalidateTargetRevision = vi.fn();
    const previewStore = {
      invalidateTargetRevision,
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      project: vi.fn(),
    } as unknown as SealedPreviewStore;
    const service = new GitHubPublicationService({
      targetStore,
      previews: previewStore,
      github: new RecordingGitHubPort(),
      reviews: new ReviewStore(),
      ruleset,
    });
    await service.configure({ repository: 'owner/repo' });
    expect(invalidateTargetRevision).toHaveBeenCalledOnce();
    await service.configure({ repository: 'owner/repo' });
    expect(invalidateTargetRevision).toHaveBeenCalledOnce();
    await service.clear();
    expect(invalidateTargetRevision).toHaveBeenCalledTimes(2);
    await service.clear();
    expect(invalidateTargetRevision).toHaveBeenCalledTimes(2);
  });

  it('previews N=1/N>1 through one deterministic read-only compiler flow', async () => {
    const targetStore = new InMemoryPublicationTargetStore();
    await targetStore.configure({ owner: 'owner', repo: 'repo' });
    const reviews = new ReviewStore();
    const first = reviewed(reviews, session('a'));
    const second = reviewed(reviews, session('b'));
    const github = new RecordingGitHubPort({
      repository: {
        id: 'R_upstream',
        slug: 'owner/repo',
        url: 'https://github.com/owner/repo',
        visibility: 'public',
        defaultBranch: 'main',
        defaultHeadSha: 'a'.repeat(40),
        viewerPermission: 'READ',
      },
      fork: null,
    });
    let counter = 0;
    const previews = new InMemorySealedPreviewStore({
      id: () => `publication_${++counter}`,
      now: () => new Date('2026-07-27T00:00:00.000Z'),
    });
    const compile = vi.fn(compileContributionBundle);
    const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
    const service = new GitHubPublicationService({
      targetStore,
      previews,
      github,
      reviews,
      ruleset,
      compilerOptions: { generatedAt: '2026-07-27T00:00:00.000Z' },
      compile,
    });
    const one = await service.preview({ reviewIds: [first] });
    const many = await service.preview({ reviewIds: [second, first, second] });
    expect(compile).toHaveBeenCalledTimes(2);
    expect(one.contribution.recordCount).toBe(1);
    expect(many.contribution.recordCount).toBe(2);
    expect(many.target).toMatchObject({
      upstream: 'owner/repo',
      pushRepository: 'actor/repo',
      forkProvision: 'on-submit',
      willCreateFork: true,
    });
    expect(
      github.calls.filter((call) =>
        ['ensureFork', 'createPullRequest'].includes(call.operation),
      ),
    ).toEqual([]);
    expect(writeFileSpy).not.toHaveBeenCalled();
    const serialized = JSON.stringify(many);
    expect(serialized).not.toContain('"contents"');
    expect(serialized).not.toContain('workspace');
    expect(serialized).not.toContain('command');
    expect(serialized).not.toContain('stderr');
    writeFileSpy.mockRestore();
  });

  it('refuses incompatible selected schemas before sealing or any write', async () => {
    const targetStore = new InMemoryPublicationTargetStore();
    await targetStore.configure({ owner: 'owner', repo: 'repo' });
    const reviews = new ReviewStore();
    const reviewId = reviewed(reviews, { ...session('future'), schemaVersion: '9.0.0' });
    const previews = new InMemorySealedPreviewStore();
    const github = new RecordingGitHubPort();
    const service = new GitHubPublicationService({
      targetStore,
      previews,
      github,
      reviews,
      ruleset,
    });
    await expect(service.preview({ reviewIds: [reviewId] })).rejects.toMatchObject({
      body: { code: 'target_incompatible' },
    });
    expect(github.calls.some((call) => call.operation === 'ensureFork')).toBe(false);
  });
});
