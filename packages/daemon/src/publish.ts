import { z } from 'zod';

import type { HandlerResult, Route } from './http.js';
import {
  PublicationError,
  type GitHubPublication,
  type PublicationErrorCode,
  type PublicationErrorPhase,
} from './publication/index.js';

const ConfigureTargetBody = z
  .object({ repository: z.string().min(1).max(140) })
  .strict();
const PreviewBody = z
  .object({ reviewIds: z.array(z.string().min(1).max(200)).min(1).max(500) })
  .strict();
const SubmitBody = z
  .object({
    publicationRef: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    targetRevision: z.number().int().nonnegative().safe(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmPublic: z.literal(true),
  })
  .strict();

const STATUS_BY_CODE: Record<PublicationErrorCode, number> = {
  invalid_target: 400,
  target_not_configured: 409,
  target_not_found: 404,
  target_incompatible: 422,
  target_changed: 409,
  target_store_unavailable: 503,
  github_client_missing: 503,
  github_login_required: 401,
  github_unavailable: 503,
  permission_denied: 403,
  fork_confirmation_required: 409,
  fork_failed: 502,
  review_not_found: 404,
  GATE_LOCKED: 409,
  precheck_refused: 422,
  preview_not_found: 404,
  preview_expired: 410,
  preview_stale: 409,
  publish_in_flight: 409,
  workspace_unavailable: 503,
  workspace_corrupt: 409,
  branch_conflict: 409,
  push_rejected: 502,
  pr_create_failed: 502,
};

const PHASE_BY_CODE: Record<PublicationErrorCode, PublicationErrorPhase> = {
  invalid_target: 'target',
  target_not_configured: 'target',
  target_not_found: 'target',
  target_incompatible: 'target',
  target_changed: 'preview',
  target_store_unavailable: 'target',
  github_client_missing: 'target',
  github_login_required: 'target',
  github_unavailable: 'target',
  permission_denied: 'target',
  fork_confirmation_required: 'push',
  fork_failed: 'push',
  review_not_found: 'preview',
  GATE_LOCKED: 'preview',
  precheck_refused: 'preview',
  preview_not_found: 'preview',
  preview_expired: 'preview',
  preview_stale: 'preview',
  publish_in_flight: 'workspace',
  workspace_unavailable: 'workspace',
  workspace_corrupt: 'workspace',
  branch_conflict: 'push',
  push_rejected: 'push',
  pr_create_failed: 'pull_request',
};

const MESSAGE_BY_CODE: Record<PublicationErrorCode, string> = {
  invalid_target: 'Enter a canonical GitHub repository as owner/repo.',
  target_not_configured: 'Configure a GitHub publication target first.',
  target_not_found: 'The configured GitHub repository was not found.',
  target_incompatible: 'The target repository is not compatible.',
  target_changed: 'The publication target changed. Create a new preview.',
  target_store_unavailable: 'Publication target configuration is unavailable.',
  github_client_missing: 'GitHub CLI is not available.',
  github_login_required: 'Sign in with gh auth login before publishing.',
  github_unavailable: 'GitHub is temporarily unavailable.',
  permission_denied: 'The GitHub account cannot publish to this repository.',
  fork_confirmation_required: 'Confirm public fork creation before publishing.',
  fork_failed: 'The GitHub fork could not be prepared.',
  review_not_found: 'A selected review was not found.',
  GATE_LOCKED: 'A selected review is still locked.',
  precheck_refused: 'Publication pre-check refused one or more selected reviews.',
  preview_not_found: 'Publication preview not found. Create a new preview.',
  preview_expired: 'This publication preview has expired. Create a new preview.',
  preview_stale: 'The publication preview is stale. Create a new preview.',
  publish_in_flight: 'Another publication is already in progress.',
  workspace_unavailable: 'The managed publication workspace is unavailable.',
  workspace_corrupt: 'The managed publication workspace is not safe to use.',
  branch_conflict: 'The contribution branch already contains different content.',
  push_rejected: 'The contribution branch could not be pushed.',
  pr_create_failed: 'The pull request could not be created.',
};

const RETRYABLE_CODES = new Set<PublicationErrorCode>([
  'target_store_unavailable',
  'github_unavailable',
  'fork_failed',
  'publish_in_flight',
  'workspace_unavailable',
  'push_rejected',
  'pr_create_failed',
]);

function safeGate(gate: unknown): unknown | undefined {
  if (typeof gate !== 'object' || gate === null || Array.isArray(gate)) return undefined;
  const value = gate as Record<string, unknown>;
  if (
    !Number.isFinite(value.blockingTotal) ||
    !Number.isFinite(value.blockingPending) ||
    !Number.isFinite(value.nonTextPending) ||
    typeof value.unlocked !== 'boolean'
  ) {
    return undefined;
  }
  return {
    blockingTotal: value.blockingTotal,
    blockingPending: value.blockingPending,
    nonTextPending: value.nonTextPending,
    unlocked: value.unlocked,
  };
}

function invalidRequest(): HandlerResult {
  return {
    status: 400,
    json: {
      code: 'invalid_request',
      message: 'The publication request is invalid.',
    },
  };
}

async function call(
  action: () => Promise<unknown>,
  successStatus = 200,
): Promise<HandlerResult> {
  try {
    return { status: successStatus, json: await action() };
  } catch (error) {
    if (error instanceof PublicationError) {
      const { code, reviewId, gate, refusals } = error.body;
      const projectedGate = safeGate(gate);
      return {
        status: STATUS_BY_CODE[code],
        json: {
          code,
          phase: PHASE_BY_CODE[code],
          message: MESSAGE_BY_CODE[code],
          retryable: RETRYABLE_CODES.has(code),
          ...(typeof reviewId === 'string' ? { reviewId } : {}),
          ...(projectedGate === undefined ? {} : { gate: projectedGate }),
          ...(Array.isArray(refusals)
            ? {
                refusals: refusals.map((refusal) => ({
                  reviewId: refusal.reviewId,
                  sessionId: refusal.sessionId,
                  blockingByRule: { ...refusal.blockingByRule },
                })),
              }
            : {}),
        },
      };
    }
    throw error;
  }
}

export function createPublishRoutes(publication: GitHubPublication): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/publish',
      handler: () => call(() => publication.inspect()),
    },
    {
      method: 'PUT',
      pattern: '/api/publish/target',
      handler: ({ body }) => {
        const parsed = ConfigureTargetBody.safeParse(body);
        return parsed.success
          ? call(() => publication.configure(parsed.data))
          : invalidRequest();
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/publish/target',
      handler: ({ body }) =>
        body === undefined
          ? call(() => publication.clear())
          : invalidRequest(),
    },
    {
      method: 'POST',
      pattern: '/api/publish/preview',
      handler: ({ body }) => {
        const parsed = PreviewBody.safeParse(body);
        return parsed.success
          ? call(() => publication.preview(parsed.data), 201)
          : invalidRequest();
      },
    },
    {
      method: 'POST',
      pattern: '/api/publish/submit',
      handler: ({ body }) => {
        const parsed = SubmitBody.safeParse(body);
        return parsed.success
          ? call(() => publication.submit(parsed.data))
          : invalidRequest();
      },
    },
  ];
}
