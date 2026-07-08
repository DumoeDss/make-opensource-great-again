/**
 * The daemon's REST surface: enumeration over `@mosga/session-readers`, the
 * stateful review lifecycle, disposition/batch/non-text/gate routes, and the
 * gated preview/export — plus same-origin `/ui` static serving. Routes operate
 * on the in-memory `ReviewStore`; request bodies are validated with `zod` and
 * responses reuse the sanitizer's `SanitizationReport` shape verbatim.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';

import {
  ConsentError,
  KeyNotConfiguredError,
  NotStampedError,
  SubmissionRefusedError,
  computeContentHash,
  estimate,
  fetchTransport,
  listProviders,
  resolveMetaVersions,
  resolveProvider,
  resolveProviderKey,
  resolveProviderPricing,
  submit,
  type Transport,
  type UserTarget,
} from '@mosga/direct-submit';
import { getAdapter, listAdapters } from '@mosga/session-readers';
import {
  type CompiledRuleset,
  DispositionSchema,
  NormalizationCategorySchema,
  applyDispositions,
  batchByRule,
  batchByType,
  compileRuleset,
  computeGate,
  type SanitizationReport,
  setFindingDisposition,
  setNonTextDisposition,
} from '@mosga/sanitizer';
import { ContributionConsentSchema, ReplayModeSchema } from '@mosga/contracts';
import { z } from 'zod';

import { buildEnvelope } from './envelope.js';
import { createRouter, readJsonBody, sendJson, type HandlerResult, type Route } from './http.js';
import { ReviewStore } from './reviews.js';
import { isUiPath, resolveUiDist, serveUi, uiNotBuiltMessage } from './staticUi.js';
import { annotateProject } from './whitelist.js';

export interface AppOptions {
  /** Home dir enumeration resolves CLI roots under. Defaults to `os.homedir()`. */
  homeDir?: string;
  /**
   * Resolve the built UI dist directory (or null when not built). Defaults to
   * runtime discovery of `@mosga/ui`. Injectable for tests.
   */
  getUiDist?: () => string | null;
  /**
   * Inject a pre-compiled ruleset (tests use this to exercise engine edge cases
   * like a `ruleset-compile-error` finding). Defaults to the vendored gitleaks
   * ruleset, compiled once and cached.
   */
  ruleset?: CompiledRuleset;
  /**
   * Path to a TRUSTED custom-rules JSON file, loaded ONCE at startup from
   * server-side config (a flag/env, never a request body). Custom rules are
   * deliberately NOT accepted per-request: taking a client-supplied path would
   * be an arbitrary file read on the loopback API (design D8 — the daemon never
   * discloses bytes outside the session under review).
   */
  customRulesPath?: string;
  /**
   * Max concurrent reviews held in memory before the least-recently-used one is
   * evicted (bounded memory). Defaults to 50.
   */
  maxReviews?: number;
  /** Override the review `exportedAt`/`generatedAt` for deterministic tests. */
  now?: string;
  /**
   * Outbound HTTP transport for 出口② direct-submit. Defaults to the real
   * `fetch` transport; tests inject a mock so no real provider call or key is
   * ever used.
   */
  submitTransport?: Transport;
  /**
   * Path to a TRUSTED local JSON key config (providerId -> key) for direct-submit,
   * loaded server-side only (a flag/env, never a request body or client path —
   * same trust model as `customRulesPath`). The key is used only as the outbound
   * auth header and never enters any daemon response.
   */
  providerKeyConfigPath?: string;
  /** User-added provider targets exposed alongside the presets (key-free). */
  userTargets?: UserTarget[];
}

export interface App {
  store: ReviewStore;
  requestListener: (req: IncomingMessage, res: ServerResponse) => void;
}

const CreateReviewBody = z.object({
  sourceId: z.string(),
  projectKey: z.string(),
  sessionId: z.string(),
});

const DispositionBody = z.object({ disposition: DispositionSchema });
const NonTextBody = z.object({ disposition: z.enum(['pending', 'keep', 'remove']) });
const BatchBody = z.object({
  by: z.enum(['rule', 'type']),
  key: z.string(),
  disposition: DispositionSchema,
});

const EstimateBody = z.object({
  providerId: z.string().optional(),
  model: z.string().optional(),
  replayMode: ReplayModeSchema.optional(),
});

const SubmitBody = z.object({
  providerId: z.string(),
  model: z.string(),
  consent: ContributionConsentSchema,
});

export function createApp(options: AppOptions = {}): App {
  const homeDir = options.homeDir ?? os.homedir();
  const getUiDist = options.getUiDist ?? resolveUiDist;
  const store = new ReviewStore(options.maxReviews);

  // Custom rules load ONCE at startup from a trusted, server-configured path —
  // never from a request body (that would be an arbitrary file read on the API).
  // A malformed/unreadable file here is a startup config error, surfaced to the
  // operator's console, not to any HTTP client.
  const customRules = loadTrustedCustomRules(options.customRulesPath);

  // The compiled ruleset is deterministic; compile it once and reuse.
  let defaultRuleset: CompiledRuleset | undefined = options.ruleset;
  const getDefaultRuleset = (): CompiledRuleset => {
    if (!defaultRuleset) {
      defaultRuleset = compileRuleset({ customRules, generatedAt: options.now });
    }
    return defaultRuleset;
  };

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: '/api/health',
      handler: () => ({ status: 200, json: { name: 'mosga-daemon', version: '0.1.0' } }),
    },

    {
      method: 'GET',
      pattern: '/api/sources',
      handler: () => ({
        status: 200,
        json: {
          sources: listAdapters().map((a) => ({ id: a.id, displayName: a.displayName })),
        },
      }),
    },

    {
      method: 'GET',
      pattern: '/api/sources/:sourceId/projects',
      handler: ({ params, url }) => {
        const adapter = getAdapter(params.sourceId);
        if (!adapter) return notFound(`unknown source "${params.sourceId}"`);
        const roots = adapter.locateRoots(homeDir);
        // Enumeration never throws on a missing/unreadable tree.
        const projects = adapter.listProjects(roots).map(annotateProject);
        const showAll = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
        const shown = showAll ? projects : projects.filter((p) => p.recommended);
        return {
          status: 200,
          json: {
            projects: shown,
            totalCount: projects.length,
            recommendedCount: projects.filter((p) => p.recommended).length,
            showAll,
          },
        };
      },
    },

    {
      method: 'GET',
      pattern: '/api/sources/:sourceId/projects/:projectKey/sessions',
      handler: ({ params }) => {
        const adapter = getAdapter(params.sourceId);
        if (!adapter) return notFound(`unknown source "${params.sourceId}"`);
        const roots = adapter.locateRoots(homeDir);
        const project = adapter.listProjects(roots).find((p) => p.key === params.projectKey);
        if (!project) return notFound(`unknown project "${params.projectKey}"`);
        return { status: 200, json: { sessions: adapter.listSessions(roots, project) } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews',
      handler: ({ body }) => {
        const parsed = CreateReviewBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        const { sourceId, projectKey, sessionId } = parsed.data;

        const adapter = getAdapter(sourceId);
        if (!adapter) return notFound(`unknown source "${sourceId}"`);
        const roots = adapter.locateRoots(homeDir);
        const project = adapter.listProjects(roots).find((p) => p.key === projectKey);
        if (!project) return notFound(`unknown project "${projectKey}"`);
        const ref = adapter.listSessions(roots, project).find((s) => s.id === sessionId);
        if (!ref) return notFound(`unknown session "${sessionId}"`);

        const messages = adapter.parseTranscriptToMessages(ref.path);
        const session = buildEnvelope(ref, messages, { exportedAt: options.now });

        const { reviewId, state } = store.create(session, getDefaultRuleset(), {
          generatedAt: options.now,
        });
        return {
          status: 201,
          json: {
            reviewId,
            report: state.report,
            rulesetWarnings: state.rulesetWarnings,
          },
        };
      },
    },

    {
      method: 'GET',
      pattern: '/api/reviews/:reviewId',
      handler: ({ params }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        return { status: 200, json: { report: state.report, gate: state.report.gate } };
      },
    },

    {
      method: 'GET',
      pattern: '/api/reviews/:reviewId/warnings',
      handler: ({ params }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        return { status: 200, json: { rulesetWarnings: state.rulesetWarnings } };
      },
    },

    {
      method: 'GET',
      pattern: '/api/reviews/:reviewId/gate',
      handler: ({ params }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        // Recompute from the held findings — counts EVERY blocking finding kind,
        // including `ruleset-compile-error` and `redos-guard` (no filtering).
        const gate = computeGate(state.report.findings, state.report.nonTextItems);
        return { status: 200, json: { gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/findings/:findingId/disposition',
      handler: ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = DispositionBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        if (!state.report.findings.some((f) => f.id === params.findingId)) {
          return notFound(`unknown finding "${params.findingId}"`);
        }
        const report = setFindingDisposition(
          state.report,
          params.findingId,
          parsed.data.disposition,
        );
        store.setReport(params.reviewId, report);
        return { status: 200, json: { report, gate: report.gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/batch',
      handler: ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = BatchBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        const { by, key, disposition } = parsed.data;
        let report;
        if (by === 'rule') {
          report = batchByRule(state.report, key, disposition);
        } else {
          const cat = NormalizationCategorySchema.safeParse(key);
          if (!cat.success) return badRequest(`invalid category "${key}"`);
          report = batchByType(state.report, cat.data, disposition);
        }
        store.setReport(params.reviewId, report);
        return { status: 200, json: { report, gate: report.gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/nontext/:messageUuid/disposition',
      handler: ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = NonTextBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        if (!state.report.nonTextItems.some((n) => n.messageUuid === params.messageUuid)) {
          return notFound(`unknown non-text item "${params.messageUuid}"`);
        }
        const report = setNonTextDisposition(
          state.report,
          params.messageUuid,
          parsed.data.disposition,
        );
        store.setReport(params.reviewId, report);
        return { status: 200, json: { report, gate: report.gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/preview',
      handler: ({ params }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        // A still-`pending` finding's raw text is NOT rewritten by
        // applyDispositions, so a naive partial-apply preview would leak an
        // undecided secret's raw bytes (design D8 forbids this). Redact pending
        // blocking findings' spans for the preview; `allow`/`replace`/`delete`
        // reflect the human's explicit decision and are shown as applied. The
        // preview is always unstamped (meta reset to the source envelope's).
        const previewReport = redactPendingBlocking(state.report);
        const result = applyDispositions(state.session, previewReport, state.mapper);
        const previewSession = { ...result.session, meta: { ...state.session.meta } };
        const gate = computeGate(state.report.findings, state.report.nonTextItems);
        return {
          status: 200,
          json: { session: previewSession, stamped: false, gate },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/export',
      handler: ({ params }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const result = applyDispositions(state.session, state.report, state.mapper);
        if (!result.gate.unlocked) {
          // Never emit a stamped session while locked — 409 with the gate.
          return {
            status: 409,
            json: { error: 'gate is locked; disposition all blocking + non-text items first', gate: result.gate },
          };
        }
        return { status: 200, json: { session: result.session, gate: result.gate } };
      },
    },

    // ---- 出口② direct-submit (MODIFIED review-daemon) --------------------
    {
      method: 'GET',
      pattern: '/api/providers',
      // Key-free provider list: open-model presets + user-added targets. Never
      // returns key material (presets carry none; keys are resolved server-side).
      handler: () => ({ status: 200, json: { providers: listProviders(options.userTargets ?? []) } }),
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/submit/estimate',
      handler: ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = EstimateBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        const { providerId, replayMode } = parsed.data;
        // Validate the provider when named, so the estimate never implies a price
        // for a target that cannot be submitted to.
        if (providerId && !resolveProvider(providerId, options.userTargets ?? [])) {
          return notFound(`unknown provider "${providerId}"`);
        }
        // Price by the selected provider, falling back to the default and
        // disclosing which (`pricingSource`) — presets carry no per-token price.
        const { pricing, pricingSource } = resolveProviderPricing(providerId);
        // Estimate over the stamped session the export path would emit. No send.
        // Also return the content hash so the consent dialog can bind consent to
        // the exact content without recomputing a hash client-side.
        const stamped = applyDispositions(state.session, state.report, state.mapper).session;
        const est = estimate(stamped, replayMode ?? 'single-shot', {
          metaVersions: resolveMetaVersions(),
          pricing,
        });
        return {
          status: 200,
          json: { ...est, pricingSource, contentHash: computeContentHash(stamped) },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/submit',
      handler: async ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = SubmitBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);

        // Derive the stamped session exactly as /export does; refuse if locked.
        const applied = applyDispositions(state.session, state.report, state.mapper);
        if (!applied.gate.unlocked) {
          return {
            status: 409,
            json: {
              error: 'gate is locked; disposition all blocking + non-text items first',
              code: 'GATE_LOCKED',
              gate: applied.gate,
            },
          };
        }

        // `consent.replayMode` is authoritative (required by the schema); the
        // top-level `SubmitBody.replayMode` is not used.
        const { providerId, model, consent } = parsed.data;
        const target = resolveProvider(providerId, options.userTargets ?? []);
        if (!target) return notFound(`unknown provider "${providerId}"`);

        // Key is read server-side; a missing key is a config error, not a leak.
        const apiKey = resolveProviderKey(providerId, {
          keyConfigPath: options.providerKeyConfigPath,
        });

        try {
          const receipt = await submit({
            session: applied.session,
            target,
            model,
            consent,
            ruleset: getDefaultRuleset(),
            apiKey,
            transport: options.submitTransport ?? fetchTransport,
            versions: resolveMetaVersions(),
            now: options.now,
            generatedAt: options.now,
          });
          return { status: 200, json: { receipt } };
        } catch (err) {
          if (err instanceof ConsentError) {
            return { status: 422, json: { error: err.message, code: 'CONSENT_INVALID' } };
          }
          if (err instanceof SubmissionRefusedError) {
            // The pre-send backstop found a surviving blocking secret — refuse,
            // report the finding, and (by construction) nothing was sent. The
            // preview is over the key-free body, so it cannot carry a key.
            return {
              status: 422,
              json: {
                error: err.message,
                code: 'BACKSTOP_BLOCKED',
                backstopBlocked: true,
                blockingFindings: err.blockingFindings,
              },
            };
          }
          if (err instanceof NotStampedError) {
            return { status: 409, json: { error: err.message, code: 'NOT_STAMPED' } };
          }
          if (err instanceof KeyNotConfiguredError) {
            // Server-side configuration state, not a malformed request. The
            // message names env-var names only, never any credential value.
            return { status: 400, json: { error: err.message, code: 'KEY_NOT_CONFIGURED' } };
          }
          // Any other error (e.g. a transport/network failure) must NOT echo its
          // raw message — a custom transport could embed sensitive detail. Log
          // the detail server-side; return a generic, key-free body.
          console.error(`[submit] unexpected error for review ${params.reviewId}:`, err);
          return { status: 500, json: { error: 'submission failed', code: 'SUBMIT_FAILED' } };
        }
      },
    },
  ];

  const router = createRouter(routes);

  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    void dispatch(req, res);
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject non-loopback Host headers. The socket is already loopback-bound, but
    // a website the user visits could point a hostname it controls at
    // 127.0.0.1 (DNS rebinding) and drive this no-auth API cross-origin. A strict
    // Host allowlist closes that vector cheaply (see README threat model).
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/') {
      res.writeHead(302, { location: '/ui/' });
      res.end();
      return;
    }

    if (isUiPath(pathname)) {
      const dist = getUiDist();
      if (!dist) {
        sendJson(res, 503, { error: uiNotBuiltMessage() });
        return;
      }
      serveUi(dist, pathname, res);
      return;
    }

    const matched = router.match(req.method ?? 'GET', pathname);
    if (!matched) {
      sendJson(res, 404, { error: `no route for ${req.method ?? 'GET'} ${pathname}` });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    try {
      const result = await matched.route.handler({ params: matched.params, url, body, req, res });
      if (!res.writableEnded) sendJson(res, result.status, result.json);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }

  return { store, requestListener };
}

function notFound(message: string): HandlerResult {
  return { status: 404, json: { error: message } };
}

function badRequest(message: string): HandlerResult {
  return { status: 400, json: { error: message } };
}

/** Hostnames the loopback API accepts (DNS-rebinding guard). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when a request's `Host` header names the loopback interface only. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  // An absent Host is only legal in HTTP/1.0; treat it as loopback-safe since
  // the socket is already 127.0.0.1-bound and no attacker origin is asserted.
  if (!hostHeader) return true;
  // Strip the port. IPv6 literals are bracketed (`[::1]:8899`).
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Load custom rules from a TRUSTED server-configured path (never a request
 * body). Returns `[]` when unset. A malformed/unreadable file throws — a startup
 * config error the operator sees, deliberately NOT reachable from HTTP so no
 * file bytes can leak into a response.
 */
function loadTrustedCustomRules(customRulesPath: string | undefined): unknown[] {
  if (!customRulesPath) return [];
  const raw = fs.readFileSync(customRulesPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Redact still-`pending` blocking findings for the preview so an undecided
 * secret's raw bytes never leave the daemon (design D8). Pending blocking
 * findings are rewritten as `replace` with a neutral `<PENDING:ruleId>` marker;
 * everything else keeps the human's chosen disposition.
 */
function redactPendingBlocking(report: SanitizationReport): SanitizationReport {
  const findings = report.findings.map((f) =>
    f.blocking && f.disposition === 'pending'
      ? { ...f, disposition: 'replace' as const, replacementSuggestion: `<PENDING:${f.ruleId}>` }
      : f,
  );
  return { ...report, findings };
}
