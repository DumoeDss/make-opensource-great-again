import { describe, expect, it } from 'vitest';

import type { GitHubPublication, PublicationPreview } from '../publication/index.js';
import { withServer } from './_helpers.js';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function preview(recordCount: number): PublicationPreview {
  return {
    publicationRef: `publication_${recordCount}`,
    expiresAt: '2026-07-27T00:15:00.000Z',
    target: {
      repositoryId: 'R_upstream',
      revision: 1,
      upstream: 'owner/repo',
      pushRepository: 'owner/repo',
      route: 'direct',
      forkProvision: 'none',
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      willCreateFork: false,
    },
    contribution: {
      contractVersion: 1,
      contentDigest: 'b'.repeat(64),
      branch: 'contrib/test/abcdef12',
      commitMessage: 'Publish reviews',
      prTitle: 'Publish reviews',
      prBody: 'Reviewed contribution',
      recordCount,
      totalBytes: 10,
      files: [],
      engine: {
        sanitizerPackageVersion: '0.1.0',
        rulesetVersion: 'rules',
        gitleaksVersion: 'gitleaks',
      },
    },
  };
}

describe('unified single/batch publication surface', () => {
  it('uses reviewIds for N=1 and N>1 and leaves every legacy route absent', async () => {
    const selections: string[][] = [];
    const publication: GitHubPublication = {
      inspect: async () => ({ state: 'unconfigured', revision: 0 }),
      configure: async () => ({ state: 'unconfigured', revision: 0 }),
      clear: async () => ({ state: 'unconfigured', revision: 0 }),
      preview: async ({ reviewIds }) => {
        selections.push([...reviewIds]);
        return preview(reviewIds.length);
      },
      submit: async () => {
        throw new Error('not used');
      },
    };
    await withServer({ publication }, async (base) => {
      for (const reviewIds of [['one'], ['one', 'two']]) {
        const response = await fetch(
          `${base}/api/publish/preview`,
          json({ reviewIds }),
        );
        expect(response.status).toBe(201);
        expect(
          ((await response.json()) as PublicationPreview).contribution.recordCount,
        ).toBe(reviewIds.length);
      }

      const legacyRoutes = [
        '/api/publish/preflight',
        '/api/publish/batch/plan',
        '/api/publish/batch/stage',
        '/api/publish/batch/submit',
        '/api/reviews/one/publish/plan',
        '/api/reviews/one/publish/stage',
        '/api/reviews/one/publish/submit',
      ];
      for (const route of legacyRoutes) {
        const response = await fetch(`${base}${route}`, json({ reviewIds: ['one'] }));
        expect(response.status, route).toBe(404);
      }
    });
    expect(selections).toEqual([['one'], ['one', 'two']]);
  });
});
