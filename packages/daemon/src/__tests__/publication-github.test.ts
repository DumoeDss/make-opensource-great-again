import {
  FakeProcessRunner,
  GhGitCredentialPort,
  GhGitHubPort,
  GitHubAdapterError,
  RecordingGitHubPort,
  provisionVerifiedFork,
  resolveGitHubTarget,
  type GitHubFork,
  type GitHubRepositorySnapshot,
  type StoredPublicationTarget,
  type TargetSnapshot,
} from '../publication/index.js';
import { describe, expect, it } from 'vitest';

const target: StoredPublicationTarget = {
  schemaVersion: 1,
  revision: 7,
  upstream: { owner: 'owner', repo: 'repo' },
};

function repository(
  overrides: Partial<GitHubRepositorySnapshot> = {},
): GitHubRepositorySnapshot {
  return {
    id: 'R_upstream',
    slug: 'owner/repo',
    url: 'https://github.com/owner/repo',
    visibility: 'public',
    defaultBranch: 'main',
    defaultHeadSha: 'a'.repeat(40),
    viewerPermission: 'WRITE',
    ...overrides,
  };
}

describe('recording GitHub semantic port and route resolution', () => {
  it('resolves direct, existing-fork, and on-submit-fork routes read-only', async () => {
    const direct = new RecordingGitHubPort();
    const directResult = await resolveGitHubTarget(target, direct);
    expect(directResult.snapshot).toMatchObject({
      route: 'direct',
      pushRepository: 'owner/repo',
      forkProvision: 'none',
      revision: 7,
    });
    expect(direct.calls.some((call) => call.operation === 'ensureFork')).toBe(false);

    const fork: GitHubFork = {
      id: 'R_fork',
      slug: 'actor/repo',
      url: 'https://github.com/actor/repo',
      owner: 'actor',
      sourceRepositoryId: 'R_upstream',
    };
    const existing = new RecordingGitHubPort({
      repository: repository({ viewerPermission: 'READ' }),
      fork,
    });
    expect((await resolveGitHubTarget(target, existing)).snapshot).toMatchObject({
      route: 'fork',
      pushRepository: 'actor/repo',
      forkProvision: 'existing',
    });
    expect(existing.calls.some((call) => call.operation === 'ensureFork')).toBe(false);

    const onSubmit = new RecordingGitHubPort({
      repository: repository({ viewerPermission: 'READ' }),
      fork: null,
    });
    expect((await resolveGitHubTarget(target, onSubmit)).snapshot).toMatchObject({
      route: 'fork',
      pushRepository: 'actor/repo',
      forkProvision: 'on-submit',
    });
    expect(onSubmit.calls.some((call) => call.operation === 'ensureFork')).toBe(false);
  });

  it('refuses unrelated forks, private/incompatible repositories, and missing capabilities safely', async () => {
    const cases = [
      new RecordingGitHubPort({
        repository: repository({ viewerPermission: 'READ' }),
        fork: {
          id: 'R_bad',
          slug: 'actor/repo',
          url: 'https://github.com/actor/repo',
          owner: 'actor',
          sourceRepositoryId: 'R_unrelated',
        },
      }),
      new RecordingGitHubPort({
        repository: repository({ visibility: 'private' }),
      }),
      new RecordingGitHubPort({
        manifest: {
          contents: JSON.stringify({
            kind: 'wrong',
            contractVersion: 1,
            acceptedSchemaVersions: ['0.1.0'],
            license: 'CC-BY-4.0',
          }),
          contentHash: 'b'.repeat(64),
        },
      }),
      new RecordingGitHubPort({
        actor: new GitHubAdapterError('login_required'),
      }),
      new RecordingGitHubPort({
        repository: new GitHubAdapterError('client_missing'),
      }),
    ];
    const expectedCodes = [
      'permission_denied',
      'target_incompatible',
      'target_incompatible',
      'github_login_required',
      'github_client_missing',
    ];
    for (let index = 0; index < cases.length; index += 1) {
      await expect(resolveGitHubTarget(target, cases[index])).rejects.toMatchObject({
        body: { code: expectedCodes[index] },
      });
      expect(JSON.stringify(cases[index].calls)).not.toContain('token');
    }
  });

  it('detects actor and permission changes through fresh resolution', async () => {
    const port = new RecordingGitHubPort();
    const first = await resolveGitHubTarget(target, port);
    expect(first.snapshot.actor).toBe('actor');
    port.state.actor = { login: 'other' };
    port.state.repository = repository({ viewerPermission: 'READ' });
    port.state.fork = null;
    const second = await resolveGitHubTarget(target, port);
    expect(second.snapshot.actor).toBe('other');
    expect(second.snapshot.pushRepository).toBe('other/repo');
  });
});

describe('submit-only fork provisioning', () => {
  const snapshot: TargetSnapshot = {
    revision: 1,
    repositoryId: 'R_upstream',
    upstream: 'owner/repo',
    upstreamUrl: 'https://github.com/owner/repo',
    actor: 'actor',
    route: 'fork',
    pushRepository: 'actor/repo',
    forkProvision: 'on-submit',
    defaultBranch: 'main',
    baseCommitSha: 'a'.repeat(40),
    manifestContentHash: 'b'.repeat(64),
    manifestContents: '{}',
    manifest: {
      kind: 'mosga-community-data',
      contractVersion: 1,
      acceptedSchemaVersions: ['0.1.0'],
      license: 'CC-BY-4.0',
    },
  };

  it('creates exactly once and adopts the verified propagated fork', async () => {
    const port = new RecordingGitHubPort({ fork: null });
    let inspections = 0;
    const original = port.inspectFork.bind(port);
    port.inspectFork = async (input) => {
      inspections += 1;
      if (inspections < 3) return original(input);
      return port.state.ensuredFork as GitHubFork;
    };
    const result = await provisionVerifiedFork(port, snapshot, {
      attempts: 4,
      wait: async () => undefined,
    });
    expect(result.slug).toBe('actor/repo');
    expect(port.calls.filter((call) => call.operation === 'ensureFork')).toHaveLength(1);
  });

  it('refuses wrong-parent results and times out with stable errors', async () => {
    const wrong = new RecordingGitHubPort({
      fork: null,
      ensuredFork: {
        id: 'R_bad',
        slug: 'actor/repo',
        url: 'https://github.com/actor/repo',
        owner: 'actor',
        sourceRepositoryId: 'R_other',
      },
    });
    await expect(provisionVerifiedFork(wrong, snapshot)).rejects.toMatchObject({
      body: { code: 'permission_denied' },
    });

    const timeout = new RecordingGitHubPort({ fork: null });
    await expect(
      provisionVerifiedFork(timeout, snapshot, {
        attempts: 2,
        wait: async () => undefined,
      }),
    ).rejects.toMatchObject({ body: { code: 'fork_failed', retryable: true } });
    expect(timeout.calls.filter((call) => call.operation === 'ensureFork')).toHaveLength(1);
  });

  it('adopts an existing-race fork without creating one', async () => {
    const existing = new RecordingGitHubPort({
      fork: {
        id: 'R_fork',
        slug: 'actor/repo',
        url: 'https://github.com/actor/repo',
        owner: 'actor',
        sourceRepositoryId: 'R_upstream',
      },
    });
    expect((await provisionVerifiedFork(existing, snapshot)).slug).toBe('actor/repo');
    expect(existing.calls.some((call) => call.operation === 'ensureFork')).toBe(false);
  });
});

describe('production gh adapter contracts', () => {
  it('uses explicit repository/ref arguments and bounded structured parsing', async () => {
    const runner = new FakeProcessRunner();
    runner.enqueue({
      code: 0,
      stdout: JSON.stringify({
        id: 'R_upstream',
        nameWithOwner: 'owner/repo',
        url: 'https://github.com/owner/repo',
        visibility: 'PUBLIC',
        defaultBranchRef: { name: 'main' },
        viewerPermission: 'WRITE',
        isFork: false,
      }),
      stderr: '',
    });
    runner.enqueue({
      code: 0,
      stdout: JSON.stringify({ sha: 'a'.repeat(40) }),
      stderr: '',
    });
    const gh = new GhGitHubPort(runner);
    expect(await gh.inspectRepository('owner/repo')).toMatchObject({
      id: 'R_upstream',
      defaultBranch: 'main',
      defaultHeadSha: 'a'.repeat(40),
    });
    expect(runner.calls.map((call) => call.args)).toEqual([
      [
        'repo',
        'view',
        'owner/repo',
        '--json',
        'id,nameWithOwner,url,visibility,defaultBranchRef,viewerPermission',
      ],
      ['api', 'repos/owner/repo/commits/main'],
    ]);

    runner.enqueue({
      code: 0,
      stdout: JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('{"kind":"mosga-community-data"}').toString('base64'),
        sha: 'b'.repeat(40),
      }),
      stderr: '',
    });
    expect(
      (
        await gh.readDatasetManifest({
          repository: 'owner/repo',
          commitSha: 'a'.repeat(40),
        })
      ).contents,
    ).toContain('mosga-community-data');
    expect(runner.calls.at(-1)?.args).toEqual([
      'api',
      `repos/owner/repo/contents/.mosga-dataset.json?ref=${'a'.repeat(40)}`,
    ]);
  });

  it('uses semantic fork PR lookup and route-aware create heads without body/token arguments', async () => {
    const runner = new FakeProcessRunner();
    const gh = new GhGitHubPort(runner);
    runner.enqueue({
      code: 0,
      stdout: JSON.stringify([]),
      stderr: 'token ghp_FAKE at C:\\private\\stderr',
    });
    const identity = {
      upstream: 'owner/repo',
      upstreamRepositoryId: 'R_upstream',
      pushRepository: 'actor/repo',
      base: 'main',
      headBranch: 'contrib/alias/session-aaaaaaaa',
    };
    expect(await gh.findPullRequest(identity)).toBeNull();
    expect(runner.calls[0].args).toEqual([
      'api',
      '--method',
      'GET',
      'repos/owner/repo/pulls',
      '-f',
      'state=all',
      '-f',
      'base=main',
      '-f',
      'head=actor:contrib/alias/session-aaaaaaaa',
      '-f',
      'per_page=100',
    ]);

    runner.enqueue({
      code: 0,
      stdout: 'https://github.com/owner/repo/pull/9\n',
      stderr: '',
    });
    const created = await gh.createPullRequest({
      ...identity,
      title: 'Safe title',
      body: 'Exact body without token',
    });
    expect(created.number).toBe(9);
    expect(runner.calls[1].args).toEqual([
      'pr',
      'create',
      '--repo',
      'owner/repo',
      '--base',
      'main',
      '--head',
      'actor:contrib/alias/session-aaaaaaaa',
      '--title',
      'Safe title',
      '--body-file',
      '-',
    ]);
    expect(runner.calls[1].options.input).toBe('Exact body without token');

    runner.enqueue({
      code: 0,
      stdout: 'https://github.com/org/repo/pull/10\n',
      stderr: '',
    });
    await expect(
      gh.createPullRequest({
        upstream: 'org/repo',
        upstreamRepositoryId: 'R_org',
        pushRepository: 'org/repo',
        base: 'main',
        headBranch: 'contrib/alias/session-bbbbbbbb',
        title: 'Direct organization PR',
        body: 'Safe body',
      }),
    ).resolves.toMatchObject({ number: 10 });
    expect(runner.calls[2].args).toEqual([
      'pr',
      'create',
      '--repo',
      'org/repo',
      '--base',
      'main',
      '--head',
      'contrib/alias/session-bbbbbbbb',
      '--title',
      'Direct organization PR',
      '--body-file',
      '-',
    ]);

    runner.enqueue({
      code: 0,
      stdout: 'https://github.com/person/repo/pull/11\n',
      stderr: '',
    });
    await gh.createPullRequest({
      upstream: 'person/repo',
      upstreamRepositoryId: 'R_person',
      pushRepository: 'person/repo',
      base: 'main',
      headBranch: 'contrib/alias/session-cccccccc',
      title: 'Direct user PR',
      body: 'Safe body',
    });
    expect(runner.calls[3].args).toContain('contrib/alias/session-cccccccc');
    expect(runner.calls[3].args).not.toContain(
      'person:contrib/alias/session-cccccccc',
    );
  });

  it('adopts only the exact semantic PR identity and rejects ambiguity', async () => {
    const exact = {
      number: 9,
      html_url: 'https://github.com/owner/repo/pull/9',
      base: {
        ref: 'main',
        repo: { node_id: 'R_upstream', full_name: 'owner/repo' },
      },
      head: {
        ref: 'contrib/alias/session-aaaaaaaa',
        repo: { full_name: 'actor/repo' },
      },
    };
    const unrelatedHeadRepository = {
      ...exact,
      number: 8,
      html_url: 'https://github.com/owner/repo/pull/8',
      head: {
        ...exact.head,
        repo: { full_name: 'actor/other-repo' },
      },
    };
    const identity = {
      upstream: 'owner/repo',
      upstreamRepositoryId: 'R_upstream',
      pushRepository: 'actor/repo',
      base: 'main',
      headBranch: 'contrib/alias/session-aaaaaaaa',
    };
    const runner = new FakeProcessRunner();
    runner.enqueue({
      code: 0,
      stdout: JSON.stringify([unrelatedHeadRepository, exact]),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(runner).findPullRequest(identity),
    ).resolves.toEqual({
      number: 9,
      url: 'https://github.com/owner/repo/pull/9',
    });

    const ambiguous = new FakeProcessRunner();
    ambiguous.enqueue({
      code: 0,
      stdout: JSON.stringify([
        exact,
        {
          ...exact,
          number: 10,
          html_url: 'https://github.com/owner/repo/pull/10',
        },
      ]),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(ambiguous).findPullRequest(identity),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps malicious/malformed stdout and raw stderr to sanitized typed failures', async () => {
    const runner = new FakeProcessRunner();
    const gh = new GhGitHubPort(runner);
    runner.enqueue({
      code: 1,
      stdout: '',
      stderr: 'ghp_FAKE C:\\private\\secret stdout stderr git push',
    });
    const error = await gh.inspectActor().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubAdapterError);
    expect(JSON.stringify(error)).not.toContain('ghp_FAKE');
    expect(JSON.stringify(error)).not.toContain('C:\\private');

    runner.enqueue({ code: 0, stdout: '{"login":', stderr: 'raw' });
    await expect(gh.inspectActor()).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'GitHub operation failed.',
    });
  });

  it('rejects repository, manifest, and PR responses that are not exactly bound to the request', async () => {
    const repositoryRunner = new FakeProcessRunner();
    repositoryRunner.enqueue({
      code: 0,
      stdout: JSON.stringify({
        id: 'R_upstream',
        nameWithOwner: 'owner/repo',
        url: 'https://github.com/attacker/repo',
        visibility: 'PUBLIC',
        defaultBranchRef: { name: 'main' },
        viewerPermission: 'WRITE',
        isFork: false,
      }),
      stderr: '',
    });
    repositoryRunner.enqueue({
      code: 0,
      stdout: JSON.stringify({ sha: 'a'.repeat(40) }),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(repositoryRunner).inspectRepository('owner/repo'),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const manifestRunner = new FakeProcessRunner();
    manifestRunner.enqueue({
      code: 0,
      stdout: JSON.stringify({
        encoding: 'base64',
        content: 'not base64',
        sha: 'b'.repeat(40),
      }),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(manifestRunner).readDatasetManifest({
        repository: 'owner/repo',
        commitSha: 'a'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const invalidUtf8Runner = new FakeProcessRunner();
    invalidUtf8Runner.enqueue({
      code: 0,
      stdout: JSON.stringify({
        encoding: 'base64',
        content: Buffer.from([0xff]).toString('base64'),
        sha: 'b'.repeat(40),
      }),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(invalidUtf8Runner).readDatasetManifest({
        repository: 'owner/repo',
        commitSha: 'a'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const pullRequestRunner = new FakeProcessRunner();
    pullRequestRunner.enqueue({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 9,
          html_url: 'https://github.com/attacker/repo/pull/9',
          base: {
            ref: 'main',
            repo: { node_id: 'R_upstream', full_name: 'owner/repo' },
          },
          head: {
            ref: 'contrib/alias/session-aaaaaaaa',
            repo: { full_name: 'actor/repo' },
          },
        },
      ]),
      stderr: '',
    });
    await expect(
      new GhGitHubPort(pullRequestRunner).findPullRequest({
        upstream: 'owner/repo',
        upstreamRepositoryId: 'R_upstream',
        pushRepository: 'actor/repo',
        base: 'main',
        headBranch: 'contrib/alias/session-aaaaaaaa',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps gh credentials out of URLs, arguments, persistence, and errors', async () => {
    const runner = new FakeProcessRunner();
    const fakeToken = 'ghp_ObviouslyFakeTokenForTestsOnly123456';
    runner.enqueue({ code: 0, stdout: '', stderr: '' });
    const credentials = new GhGitCredentialPort(runner);
    await credentials.withCredentials(async (environment) => {
      expect(environment).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
        GIT_CONFIG_VALUE_0: '!gh auth git-credential',
        GIT_TERMINAL_PROMPT: '0',
      });
    });
    expect(runner.calls[0].args).toEqual([
      'auth',
      'status',
      '--hostname',
      'github.com',
    ]);
    expect(JSON.stringify(runner.calls)).not.toContain(fakeToken);

    runner.enqueue({
      code: 1,
      stdout: '',
      stderr: `${fakeToken} C:\\private\\askpass stderr`,
    });
    const error = await credentials
      .withCredentials(async () => undefined)
      .catch((value: unknown) => value);
    expect(JSON.stringify(error)).not.toContain(fakeToken);
    expect(JSON.stringify(error)).not.toContain('C:\\private');
  });
});
