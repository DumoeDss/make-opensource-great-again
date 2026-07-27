import { createHash } from 'node:crypto';

import type { SanitizedSession } from '@mosga/contracts';
import {
  compileContributionBundle,
  computeContributionContentDigest,
  type ContributionBundle,
  type ContributionBundleOptions,
} from '@mosga/publisher';
import { compileRuleset, type CompiledRuleset } from '@mosga/sanitizer';
import { describe, expect, it, vi } from 'vitest';

import { ReviewStore } from '../reviews.js';
import {
  InMemoryPublicationReceiptStore,
  InMemoryPublicationTargetStore,
  InMemorySealedPreviewStore,
  RecordingGitHubPort,
  SubmitPreflight,
  resolveGitHubTarget,
  selectPublicationReviews,
  type PublicationReceiptStore,
  type SealedPublication,
} from '../publication/index.js';
import { FAKE_AWS_KEY } from './_helpers.js';

const ruleset = compileRuleset({ generatedAt: '2026-07-27T00:00:00.000Z' });

function session(id = 'session'): SanitizedSession {
  return {
    schemaVersion: '0.1.0',
    meta: {
      contributorAlias: '<CONTRIBUTOR>',
      sourceCli: 'claude-code',
      toolVersion: '1.0.0',
      sanitizationRulesetVersion: 'rules',
      exportedAt: '2026-07-27T00:00:00.000Z',
      license: 'CC-BY-4.0',
      sanitized: true,
    },
    session: {
      sessionId: id,
      sourceId: id,
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
        content: 'a clean exact record',
        sdkMessageType: 'message',
        timestamp: 1,
      },
    ],
  };
}

function hash(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

function recommit(bundle: ContributionBundle): void {
  for (const file of bundle.files) {
    file.bytes = Buffer.byteLength(file.contents, 'utf8');
    file.contentHash = hash(file.contents);
  }
  bundle.totalBytes = bundle.files.reduce((total, file) => total + file.bytes, 0);
  bundle.contentDigest = computeContributionContentDigest(bundle.files);
  bundle.branch = bundle.branch.replace(/[a-f0-9]{8}$/, bundle.contentDigest.slice(0, 8));
}

interface Fixture {
  targetStore: InMemoryPublicationTargetStore;
  reviewStore: ReviewStore;
  reviewId: string;
  github: RecordingGitHubPort;
  previews: InMemorySealedPreviewStore;
  receipts: PublicationReceiptStore;
  seal: SealedPublication;
  createPreflight(options?: {
    currentRuleset?: () => CompiledRuleset;
    compile?: typeof compileContributionBundle;
    reviews?: ReviewStore;
    previews?: InMemorySealedPreviewStore;
  }): SubmitPreflight;
}

async function fixture(): Promise<Fixture> {
  const targetStore = new InMemoryPublicationTargetStore();
  await targetStore.configure({ owner: 'owner', repo: 'repo' });
  const reviewStore = new ReviewStore();
  const reviewId = reviewStore.create(session(), ruleset, {
    generatedAt: '2026-07-27T00:00:00.000Z',
  }).reviewId;
  const github = new RecordingGitHubPort();
  const selected = selectPublicationReviews([reviewId], reviewStore);
  const target = await resolveGitHubTarget(await targetStore.read(), github);
  const compilerOptions: ContributionBundleOptions = {
    ruleset,
    generatedAt: '2026-07-27T00:00:00.000Z',
    sanitizerPackageVersion: '0.1.0',
    gitleaksVersion: ruleset.gitleaksVersion,
    license: target.snapshot.manifest.license,
  };
  const bundle = compileContributionBundle(
    selected.map((item) => item.session),
    compilerOptions,
  );
  let counter = 0;
  const previews = new InMemorySealedPreviewStore({
    id: () => `publication_${++counter}`,
    now: () => new Date('2026-07-27T00:00:00.000Z'),
  });
  const seal = previews.put({
    reviewIds: [reviewId],
    reviewSessionIds: { [reviewId]: 'session' },
    target: target.snapshot,
    bundle,
    compilerOptions,
    ruleset,
  });
  const receipts = new InMemoryPublicationReceiptStore();
  return {
    targetStore,
    reviewStore,
    reviewId,
    github,
    previews,
    receipts,
    seal,
    createPreflight: (options = {}) =>
      new SubmitPreflight({
        receipts,
        previews: options.previews ?? previews,
        targets: targetStore,
        reviews: options.reviews ?? reviewStore,
        github,
        currentRuleset: options.currentRuleset ?? (() => ruleset),
        compile: options.compile,
      }),
  };
}

function request(value: Fixture): {
  publicationRef: string;
  targetRevision: number;
  contentDigest: string;
  confirmPublic: true;
} {
  return {
    publicationRef: value.seal.publicationRef,
    targetRevision: value.seal.target.revision,
    contentDigest: value.seal.bundle.contentDigest,
    confirmPublic: true,
  };
}

function expectNoGitHubWrites(value: Fixture): void {
  expect(
    value.github.calls.filter((call) =>
      ['ensureFork', 'createPullRequest'].includes(call.operation),
    ),
  ).toEqual([]);
}

describe('confirmed submit pre-write validation', () => {
  it('validates bindings and returns a fully revalidated sealed submission', async () => {
    const value = await fixture();
    const result = await value.createPreflight().validate(request(value));
    expect(result).toMatchObject({
      kind: 'validated',
      seal: { publicationRef: value.seal.publicationRef },
      target: { upstream: 'owner/repo', baseCommitSha: 'a'.repeat(40) },
    });
    expectNoGitHubWrites(value);
  });

  it('returns the exact existing receipt before looking for an in-memory seal', async () => {
    const value = await fixture();
    const existing = {
      publicationRef: value.seal.publicationRef,
      targetRevision: value.seal.target.revision,
      upstream: 'owner/repo',
      pushRepository: 'owner/repo',
      mode: 'direct' as const,
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      branch: value.seal.bundle.branch,
      commitSha: 'c'.repeat(40),
      prNumber: 4,
      prUrl: 'https://github.com/owner/repo/pull/4',
      recordCount: 1,
      contentDigest: value.seal.bundle.contentDigest,
      submittedAt: '2026-07-27T00:01:00.000Z',
    };
    await value.receipts.write(existing);
    value.previews.delete(value.seal.publicationRef);
    await expect(value.createPreflight().validate(request(value))).resolves.toEqual({
      kind: 'receipt',
      receipt: existing,
    });
    expectNoGitHubWrites(value);
  });

  it('strictly rejects false confirmation and every extra authority field', async () => {
    const value = await fixture();
    const read = vi.spyOn(value.receipts, 'read');
    for (const body of [
      { ...request(value), confirmPublic: false },
      { ...request(value), workspacePath: 'C:\\private' },
      { ...request(value), remote: 'evil' },
      { ...request(value), token: 'ghp_FAKE' },
      { ...request(value), base: 'other' },
      { ...request(value), branch: 'main' },
    ]) {
      await expect(value.createPreflight().validate(body)).rejects.toMatchObject({
        body: { code: 'preview_stale' },
      });
    }
    expect(read).not.toHaveBeenCalled();
    expectNoGitHubWrites(value);
  });

  it('refuses missing refs and mismatched revision/digest without mutation', async () => {
    const value = await fixture();
    await expect(
      value.createPreflight().validate({
        ...request(value),
        publicationRef: 'missing',
      }),
    ).rejects.toMatchObject({ body: { code: 'preview_not_found' } });
    await expect(
      value.createPreflight().validate({
        ...request(value),
        targetRevision: value.seal.target.revision + 1,
      }),
    ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
    await expect(
      value.createPreflight().validate({
        ...request(value),
        contentDigest: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
    expectNoGitHubWrites(value);
  });

  it('refuses expired seals plus missing or newly locked reviews without mutation', async () => {
    const expired = await fixture();
    let now = new Date('2026-07-27T00:00:00.000Z');
    const expiredStore = new InMemorySealedPreviewStore({
      id: () => expired.seal.publicationRef,
      now: () => now,
      ttlMs: 1,
    });
    expiredStore.put({
      reviewIds: expired.seal.reviewIds,
      reviewSessionIds: expired.seal.reviewSessionIds,
      target: expired.seal.target,
      bundle: expired.seal.bundle,
      compilerOptions: expired.seal.compilerOptions,
      ruleset: expired.seal.ruleset,
    });
    now = new Date('2026-07-27T00:00:00.001Z');
    await expect(
      expired
        .createPreflight({ previews: expiredStore })
        .validate(request(expired)),
    ).rejects.toMatchObject({ body: { code: 'preview_expired' } });
    expectNoGitHubWrites(expired);

    const missing = await fixture();
    const noReviews = { get: () => undefined } as unknown as ReviewStore;
    await expect(
      missing
        .createPreflight({ reviews: noReviews })
        .validate(request(missing)),
    ).rejects.toMatchObject({ body: { code: 'review_not_found' } });
    expectNoGitHubWrites(missing);

    const locked = await fixture();
    const state = locked.reviewStore.get(locked.reviewId);
    if (!state) throw new Error('fixture review missing');
    const lockedStore = new ReviewStore();
    const lockedId = lockedStore.create(
      {
        ...session(),
        messages: [
          {
            ...session().messages[0],
            content: `secret ${FAKE_AWS_KEY}`,
          },
        ],
      },
      ruleset,
    ).reviewId;
    const lockedState = lockedStore.get(lockedId);
    if (!lockedState) throw new Error('locked fixture missing');
    state.report = lockedState.report;
    await expect(
      locked.createPreflight().validate(request(locked)),
    ).rejects.toMatchObject({ body: { code: 'GATE_LOCKED' } });
    expectNoGitHubWrites(locked);
  });

  it('refuses changed targets, reviews, engine identity, and tampered bundles before writes', async () => {
    const changedTarget = await fixture();
    await changedTarget.targetStore.configure({ owner: 'other', repo: 'repo' });
    await expect(
      changedTarget.createPreflight().validate(request(changedTarget)),
    ).rejects.toMatchObject({ body: { code: 'target_changed' } });
    expectNoGitHubWrites(changedTarget);

    const changedReview = await fixture();
    const reviewState = changedReview.reviewStore.get(changedReview.reviewId);
    if (!reviewState) throw new Error('fixture review missing');
    reviewState.session.messages[0].content = 'changed but still clean';
    await expect(
      changedReview.createPreflight().validate(request(changedReview)),
    ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
    expectNoGitHubWrites(changedReview);

    const drift = await fixture();
    const driftedRuleset = {
      ...ruleset,
      rulesetVersion: `${ruleset.rulesetVersion}+drift`,
    } as CompiledRuleset;
    await expect(
      drift
        .createPreflight({ currentRuleset: () => driftedRuleset })
        .validate(request(drift)),
    ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
    expectNoGitHubWrites(drift);

    const tampered = await fixture();
    tampered.seal.bundle.files[0].bytes += 1;
    await expect(
      tampered
        .createPreflight({ compile: () => tampered.seal.bundle })
        .validate(request(tampered)),
    ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
    expectNoGitHubWrites(tampered);
  });

  it('refuses changed base, manifest, actor, and route snapshots before mutation', async () => {
    const mutations: Array<(value: Fixture) => void> = [
      (value) => {
        const repo = value.github.state.repository;
        if (repo instanceof Error) throw repo;
        repo.defaultHeadSha = 'd'.repeat(40);
      },
      (value) => {
        const manifest = value.github.state.manifest;
        if (manifest instanceof Error) throw manifest;
        manifest.contentHash = 'e'.repeat(64);
      },
      (value) => {
        value.github.state.actor = { login: 'changed-actor' };
      },
      (value) => {
        const repo = value.github.state.repository;
        if (repo instanceof Error) throw repo;
        repo.viewerPermission = 'READ';
        value.github.state.fork = null;
      },
    ];
    for (const mutate of mutations) {
      const value = await fixture();
      mutate(value);
      await expect(
        value.createPreflight().validate(request(value)),
      ).rejects.toMatchObject({ body: { code: 'preview_stale' } });
      expectNoGitHubWrites(value);
    }
  });

  it('rechecks exact record bodies and provenance sidecars with rule-count-only refusals', async () => {
    for (const kind of ['record', 'provenance'] as const) {
      const value = await fixture();
      const file = value.seal.bundle.files.find((candidate) => candidate.kind === kind);
      if (!file) throw new Error('fixture file missing');
      if (kind === 'record') {
        const record = JSON.parse(file.contents) as SanitizedSession;
        record.meta.toolVersion = FAKE_AWS_KEY;
        file.contents = `${JSON.stringify(record)}\n`;
      } else {
        file.contents = `${file.contents.trimEnd()}\n${FAKE_AWS_KEY}\n`;
      }
      recommit(value.seal.bundle);
      const preflight = value.createPreflight({
        compile: () => value.seal.bundle,
      });
      const error = await preflight
        .validate(request(value))
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        body: {
          code: 'precheck_refused',
          refusals: [
            {
              reviewId: value.reviewId,
              sessionId: 'session',
              blockingByRule: expect.any(Object),
            },
          ],
        },
      });
      const serialized = JSON.stringify(error.body);
      expect(serialized).not.toContain(FAKE_AWS_KEY);
      expect(serialized).not.toContain(file.contents);
      expectNoGitHubWrites(value);
    }
  });
});
