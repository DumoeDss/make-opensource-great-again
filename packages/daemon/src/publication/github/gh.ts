import { Buffer } from 'node:buffer';

import type { ProcessRunner } from '../workspace/process.js';
import {
  GitHubAdapterError,
  type CreatePullRequestInput,
  type GitHubActor,
  type GitHubFork,
  type GitHubManifestAtCommit,
  type GitHubPort,
  type GitHubPullRequest,
  type GitHubRepositorySnapshot,
  type GitHubViewerPermission,
  type PullRequestIdentity,
} from './port.js';

const MAX_JSON_BYTES = 1024 * 1024;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SLUG_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[a-fA-F0-9]{40,64}$/;

function adapterFailure(code: GitHubAdapterError['code']): never {
  throw new GitHubAdapterError(code);
}

function parseJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_JSON_BYTES) return adapterFailure('invalid_response');
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return adapterFailure('invalid_response');
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return adapterFailure('invalid_response');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, max = 500): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0 || field.length > max) {
    return adapterFailure('invalid_response');
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 1) {
    return adapterFailure('invalid_response');
  }
  return field as number;
}

function exactGitHubRepositoryUrl(url: string, slug: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname.toLowerCase() === `/${slug.toLowerCase()}`
    );
  } catch {
    return false;
  }
}

function mapFailure(code: number): never {
  if (code === 127) return adapterFailure('client_missing');
  if (code === 4) return adapterFailure('login_required');
  if (code === 2) return adapterFailure('not_found');
  if (code === 1) return adapterFailure('permission_denied');
  return adapterFailure('unavailable');
}

export class GhGitHubPort implements GitHubPort {
  constructor(private readonly runner: ProcessRunner) {}

  async inspectActor(): Promise<GitHubActor> {
    const raw = await this.read(['api', 'user']);
    const login = stringField(object(raw), 'login', 39);
    if (!LOGIN_RE.test(login)) return adapterFailure('invalid_response');
    return { login };
  }

  async inspectRepository(slug: string): Promise<GitHubRepositorySnapshot> {
    this.assertSlug(slug);
    const view = object(
      await this.read([
        'repo',
        'view',
        slug,
        '--json',
        'id,nameWithOwner,url,visibility,defaultBranchRef,viewerPermission',
      ]),
    );
    const defaultBranchRef = object(view.defaultBranchRef);
    const defaultBranch = stringField(defaultBranchRef, 'name', 255);
    const head = object(
      await this.read(['api', `repos/${slug}/commits/${encodeURIComponent(defaultBranch)}`]),
    );
    const canonicalSlug = stringField(view, 'nameWithOwner', 140);
    this.assertSlug(canonicalSlug);
    const url = stringField(view, 'url', 500);
    if (!exactGitHubRepositoryUrl(url, canonicalSlug)) {
      return adapterFailure('invalid_response');
    }
    const visibilityRaw = stringField(view, 'visibility', 20).toUpperCase();
    if (visibilityRaw !== 'PUBLIC' && visibilityRaw !== 'PRIVATE') {
      return adapterFailure('invalid_response');
    }
    const permission = stringField(view, 'viewerPermission', 20).toUpperCase();
    if (!['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', 'NONE'].includes(permission)) {
      return adapterFailure('invalid_response');
    }
    const sha = stringField(head, 'sha', 64);
    if (!SHA_RE.test(sha)) return adapterFailure('invalid_response');
    return {
      id: stringField(view, 'id', 200),
      slug: canonicalSlug,
      url,
      visibility: visibilityRaw === 'PUBLIC' ? 'public' : 'private',
      defaultBranch,
      defaultHeadSha: sha,
      viewerPermission: permission as GitHubViewerPermission,
    };
  }

  async readDatasetManifest(input: {
    repository: string;
    commitSha: string;
  }): Promise<GitHubManifestAtCommit> {
    this.assertSlug(input.repository);
    if (!SHA_RE.test(input.commitSha)) return adapterFailure('invalid_response');
    const raw = object(
      await this.read([
        'api',
        `repos/${input.repository}/contents/.mosga-dataset.json?ref=${input.commitSha}`,
      ]),
    );
    const encoding = stringField(raw, 'encoding', 20);
    if (encoding !== 'base64') return adapterFailure('invalid_response');
    const content = stringField(raw, 'content', MAX_JSON_BYTES);
    const normalizedContent = content.replace(/\s/g, '');
    if (
      normalizedContent.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        normalizedContent,
      )
    ) {
      return adapterFailure('invalid_response');
    }
    let contents: string;
    try {
      const decoded = Buffer.from(normalizedContent, 'base64');
      if (decoded.toString('base64') !== normalizedContent) {
        return adapterFailure('invalid_response');
      }
      contents = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    } catch {
      return adapterFailure('invalid_response');
    }
    const contentHash = stringField(raw, 'sha', 64).toLowerCase();
    if (!SHA_RE.test(contentHash)) return adapterFailure('invalid_response');
    return {
      contents,
      contentHash,
    };
  }

  async inspectFork(input: {
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork | null> {
    this.assertSlug(input.expectedSlug);
    const result = await this.runner.run('gh', [
      'repo',
      'view',
      input.expectedSlug,
      '--json',
      'id,nameWithOwner,url,isFork,parent',
    ]);
    if (result.code === 2) return null;
    if (result.code !== 0) return mapFailure(result.code);
    return this.parseFork(parseJson(result.stdout), input.upstreamRepositoryId, input.actor);
  }

  async ensureFork(input: {
    upstream: string;
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork> {
    this.assertSlug(input.upstream);
    const result = await this.runner.run('gh', [
      'repo',
      'fork',
      input.upstream,
      '--clone=false',
    ]);
    if (result.code !== 0 && result.code !== 1) return mapFailure(result.code);
    const fork = await this.inspectFork(input);
    if (!fork) return adapterFailure('write_failed');
    return fork;
  }

  async findPullRequest(input: PullRequestIdentity): Promise<GitHubPullRequest | null> {
    const identity = this.validatePullRequestIdentity(input);
    const pushOwner = identity.pushRepository.split('/')[0];
    const raw = await this.read([
      'api',
      '--method',
      'GET',
      `repos/${identity.upstream}/pulls`,
      '-f',
      'state=all',
      '-f',
      `base=${identity.base}`,
      '-f',
      `head=${pushOwner}:${identity.headBranch}`,
      '-f',
      'per_page=100',
    ]);
    if (!Array.isArray(raw) || raw.length > 100) {
      return adapterFailure('invalid_response');
    }
    const exact: GitHubPullRequest[] = [];
    for (const candidate of raw) {
      const parsed = this.parsePullRequestCandidate(candidate, identity);
      if (parsed) exact.push(parsed);
    }
    if (exact.length > 1) return adapterFailure('invalid_response');
    return exact[0] ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const identity = this.validatePullRequestIdentity(input);
    const push = identity.pushRepository.split('/');
    const head =
      identity.pushRepository.toLowerCase() === identity.upstream.toLowerCase()
        ? identity.headBranch
        : `${push[0]}:${identity.headBranch}`;
    const args = [
      'pr',
      'create',
      '--repo',
      identity.upstream,
      '--base',
      identity.base,
      '--head',
      head,
      '--title',
      input.title,
      '--body-file',
      '-',
    ];
    const result = await this.runner.run('gh', args, { input: input.body });
    if (result.code !== 0) return adapterFailure('write_failed');
    return this.parsePullRequest(
      { number: this.pullRequestNumber(result.stdout.trim()), url: result.stdout.trim() },
      input.upstream,
    );
  }

  private async read(args: string[]): Promise<unknown> {
    const result = await this.runner.run('gh', args);
    if (result.code !== 0) return mapFailure(result.code);
    return parseJson(result.stdout);
  }

  private assertSlug(slug: string): void {
    if (!SLUG_RE.test(slug) || slug.includes('..') || slug.endsWith('.git')) {
      return adapterFailure('invalid_response');
    }
  }

  private parseFork(
    raw: unknown,
    upstreamRepositoryId: string,
    actor: string,
  ): GitHubFork {
    const value = object(raw);
    if (value.isFork !== true) return adapterFailure('invalid_response');
    const slug = stringField(value, 'nameWithOwner', 140);
    this.assertSlug(slug);
    const parent = object(value.parent);
    const sourceRepositoryId = stringField(parent, 'id', 200);
    const owner = slug.split('/')[0];
    if (
      owner.toLowerCase() !== actor.toLowerCase() ||
      sourceRepositoryId !== upstreamRepositoryId
    ) {
      return adapterFailure('permission_denied');
    }
    const url = stringField(value, 'url', 500);
    if (!exactGitHubRepositoryUrl(url, slug)) {
      return adapterFailure('invalid_response');
    }
    return {
      id: stringField(value, 'id', 200),
      slug,
      url,
      owner,
      sourceRepositoryId,
    };
  }

  private parsePullRequest(raw: unknown, upstream: string): GitHubPullRequest {
    const value = object(raw);
    const url = stringField(value, 'url', 500);
    const number = numberField(value, 'number');
    if (
      url !== `https://github.com/${upstream}/pull/${String(number)}`
    ) {
      return adapterFailure('invalid_response');
    }
    return { number, url };
  }

  private parsePullRequestCandidate(
    raw: unknown,
    identity: PullRequestIdentity,
  ): GitHubPullRequest | null {
    const value = object(raw);
    const number = numberField(value, 'number');
    const url = stringField(value, 'html_url', 500);
    const base = object(value.base);
    const head = object(value.head);
    const baseRepository = object(base.repo);
    const headRepository = object(head.repo);
    const baseRef = stringField(base, 'ref', 255);
    const headRef = stringField(head, 'ref', 255);
    const baseRepositoryId = stringField(baseRepository, 'node_id', 200);
    const baseRepositorySlug = stringField(baseRepository, 'full_name', 140);
    const headRepositorySlug = stringField(headRepository, 'full_name', 140);
    this.assertSlug(baseRepositorySlug);
    this.assertSlug(headRepositorySlug);
    if (
      baseRef !== identity.base ||
      headRef !== identity.headBranch ||
      baseRepositoryId !== identity.upstreamRepositoryId ||
      baseRepositorySlug.toLowerCase() !== identity.upstream.toLowerCase() ||
      headRepositorySlug.toLowerCase() !==
        identity.pushRepository.toLowerCase()
    ) {
      return null;
    }
    if (url !== `https://github.com/${identity.upstream}/pull/${String(number)}`) {
      return adapterFailure('invalid_response');
    }
    return { number, url };
  }

  private pullRequestNumber(url: string): number {
    const match = /\/pull\/([1-9][0-9]*)$/.exec(url);
    if (!match) return adapterFailure('invalid_response');
    return Number(match[1]);
  }

  private validatePullRequestIdentity(
    input: PullRequestIdentity,
  ): PullRequestIdentity {
    this.assertSlug(input.upstream);
    this.assertSlug(input.pushRepository);
    if (
      typeof input.upstreamRepositoryId !== 'string' ||
      input.upstreamRepositoryId.length < 1 ||
      input.upstreamRepositoryId.length > 200 ||
      input.base.length < 1 ||
      input.base.length > 255 ||
      input.headBranch.length < 1 ||
      input.headBranch.length > 255 ||
      /[\u0000-\u0020\u007f]/.test(input.base) ||
      /[\u0000-\u0020\u007f]/.test(input.headBranch)
    ) {
      return adapterFailure('invalid_response');
    }
    return input;
  }
}
