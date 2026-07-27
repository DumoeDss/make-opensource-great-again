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
import path from 'node:path';

import {
  ALLOWED_PRESET_IDS,
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
  REPLAY_REPORT_VERSION,
  ReplayFindingDispositionSchema,
  ReplayOpaqueDispositionSchema,
  applyDispositions,
  applyReplayDispositions,
  batchByRule,
  batchByType,
  compileRuleset,
  computeGate,
  type SanitizationReport,
  scanReplayDraft,
  setFindingDisposition,
  setNonTextDisposition,
} from '@mosga/sanitizer';
import { CliResumeConsentSchema, ContributionConsentSchema, ReplayModeSchema } from '@mosga/contracts';
import { createReplayDraft, sealReplayBundle } from '@mosga/replay-bundle';
import { submitCliResume } from '@mosga/replay-submit';
import type { ReplayProxy, ReplayUpstreamTarget } from '@mosga/replay-proxy';
import type { ReplayRuntime } from '@mosga/replay-runtime';
import { z } from 'zod';

import { buildEnvelope } from './envelope.js';
import { createRouter, readJsonBody, sendJson, type HandlerResult, type Route } from './http.js';
import {
  setReplayFindingDisposition,
  setReplayOpaqueDisposition,
  type ReplayReviewState,
} from './replayReview.js';
import {
  buildInitialOmissions,
  buildReplayRuntimePolicy,
  buildSanitizationProvenance,
  buildTerminalManifestSeed,
  discoverInstructionCandidates,
  newDecisionVersion,
  newDraftId,
} from './replayPrep.js';
import {
  createProviderStore,
  ProviderConflictError,
  type ProviderStore,
} from './providerStore.js';
import { createPublishRoutes } from './publish.js';
import {
  FilePublicationJournalStore,
  FilePublicationLock,
  FilePublicationReceiptStore,
  FilePublicationTargetStore,
  GhGitCredentialPort,
  GhGitHubPort,
  GitHubPublicationService,
  InMemorySealedPreviewStore,
  ManagedGitWorkspace,
  PublicationSubmitStateMachine,
  SpawnProcessRunner,
  SubmitPreflight,
  type GitHubPort,
  type GitHubPublication,
  type GitWorkspacePort,
  type PublicationJournalStore,
  type PublicationLock,
  type PublicationReceiptStore,
  type PublicationTargetStore,
  type SealedPreviewStore,
} from './publication/index.js';
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
   * evicted (bounded memory). Defaults to 500 — raised to support large batch
   * queues now that the picker no longer caps the selection; the LRU still bounds
   * memory, it just sits far above any realistic single batch.
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
  /**
   * The user-scope persistence store for custom providers + encrypted API keys.
   * Defaults to a file-backed store under `~/.mosga/`; tests inject an in-memory
   * fake (`createInMemoryProviderStore`) so no disk or real key is touched.
   */
  providerStore?: ProviderStore;
  /** Path to the user-scope custom-providers file. Default `~/.mosga/user-providers.json`. */
  userProvidersPath?: string;
  /** Path to the encrypted user-scope key store. Default `~/.mosga/provider-keys.json`. */
  providerKeysPath?: string;
  /** Path to the master keyfile encrypting the key store. Default `~/.mosga/master.key`. */
  masterKeyFilePath?: string;
  /**
   * The replay runtime for cli-resume submissions (出口② request-authenticity
   * path). Injectable for tests (a fake that launches no real CLI); when absent,
   * cli-resume submissions return a SUBMIT_FAILED configuration error and the
   * reconstructed-API path is unaffected.
   */
  replayRuntime?: ReplayRuntime;
  /**
   * The replay proxy for cli-resume submissions. Same injection model as
   * `replayRuntime`.
   */
  replayProxy?: ReplayProxy;
  publication?: GitHubPublication;
  /** Internal/test-only; no CLI or HTTP surface exposes this managed root. */
  publicationRoot?: string;
  publicationGitHub?: GitHubPort;
  publicationTargetStore?: PublicationTargetStore;
  publicationPreviews?: SealedPreviewStore;
  publicationJournals?: PublicationJournalStore;
  publicationReceipts?: PublicationReceiptStore;
  publicationLock?: PublicationLock;
  publicationWorkspace?: GitWorkspacePort;
}

export interface App {
  store: ReviewStore;
  publication: GitHubPublication;
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

/**
 * Cli-resume submit body. The consent carries `replayMode: 'cli-resume'` and
 * binds the validated bundle content hash. The sealed `ReplayBundle` is sent
 * directly (it carries no API key material). A separate schema from `SubmitBody`
 * keeps the no-fallback boundary clean: the handler branches on
 * `consent.replayMode` BEFORE validating either schema.
 */
const CliResumeSubmitBody = z.object({
  providerId: z.string(),
  model: z.string(),
  consent: CliResumeConsentSchema,
  bundle: z.unknown(),
});

/**
 * Replay-preparation body. The user chooses the delivery target (provider +
 * model); the daemon captures the native session, builds the draft, and scans it.
 * No secrets, no bundle content — only the target identifiers.
 */
const ReplayPrepareBody = z.object({
  targetProviderId: z.string().min(1),
  targetModel: z.string().min(1),
});

/** Replay-finding disposition body (pending / replace / delete / allow). */
const ReplayFindingDispositionBody = z.object({
  disposition: ReplayFindingDispositionSchema,
});

/**
 * Replay-opaque disposition body. `remove`/`keep`/`pending` need no replacement;
 * `replace` requires an explicit JSON replacement value (never opaque bytes).
 */
const ReplayOpaqueDispositionBody = z.object({
  disposition: ReplayOpaqueDispositionSchema,
  replacement: z.unknown().optional(),
});

/** The four supported request formats for a custom provider. */
const ApiFormatSchema = z.enum(['openai', 'openai-response', 'anthropic', 'gemini']);

/** An `http(s)` URL — the only shape a custom provider's base URL may take. */
const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), { message: 'apiBaseUrl must be an http(s) URL' });

/** Custom-provider create body (id supplied by the client). NEVER carries a key. */
const CustomProviderBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  apiFormat: ApiFormatSchema,
  apiBaseUrl: HttpUrlSchema,
  models: z.array(z.string()),
});

/** Custom-provider update body (id comes from the route param). */
const CustomProviderUpdateBody = CustomProviderBody.omit({ id: true });

/** Provider-key set body — write-only; the value is never echoed back. */
const ProviderKeyBody = z.object({ apiKey: z.string().min(1) });

export function createApp(options: AppOptions = {}): App {
  const homeDir = options.homeDir ?? os.homedir();
  const getUiDist = options.getUiDist ?? resolveUiDist;
  const store = new ReviewStore(options.maxReviews);

  // User-scope persistence for custom providers + encrypted keys. Injectable for
  // tests (an in-memory fake); otherwise file-backed under `~/.mosga/`.
  const providerStore =
    options.providerStore ??
    createProviderStore({
      homeDir,
      userProvidersPath: options.userProvidersPath,
      keysPath: options.providerKeysPath,
      masterKeyFilePath: options.masterKeyFilePath,
    });

  // The provider targets to expose: injected `userTargets` first, then persisted
  // custom providers (injected wins on id collision — keeps tests deterministic).
  const mergedTargets = (): UserTarget[] => providerStore.mergedTargets(options.userTargets ?? []);

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

  const publicationRoot =
    options.publicationRoot ?? path.join(homeDir, '.mosga', 'publication');
  const publication = options.publication ?? (() => {
    const processRunner = new SpawnProcessRunner();
    const targetStore =
      options.publicationTargetStore ??
      new FilePublicationTargetStore(path.join(publicationRoot, 'target.json'));
    const previews =
      options.publicationPreviews ?? new InMemorySealedPreviewStore();
    const github =
      options.publicationGitHub ?? new GhGitHubPort(processRunner);
    const journals =
      options.publicationJournals ??
      new FilePublicationJournalStore(path.join(publicationRoot, 'journals'));
    const receipts =
      options.publicationReceipts ??
      new FilePublicationReceiptStore(path.join(publicationRoot, 'receipts'));
    const lock =
      options.publicationLock ??
      new FilePublicationLock(path.join(publicationRoot, 'runtime', 'publish.lock'));
    const workspace =
      options.publicationWorkspace ??
      new ManagedGitWorkspace(
        processRunner,
        new GhGitCredentialPort(processRunner),
      );
    const preflight = new SubmitPreflight({
      receipts,
      previews,
      targets: targetStore,
      reviews: store,
      github,
      currentRuleset: getDefaultRuleset,
    });
    const submit = new PublicationSubmitStateMachine({
      preflight,
      journals,
      receipts,
      lock,
      previews,
      workspace,
      github,
      managedRoot: publicationRoot,
    });
    return new GitHubPublicationService({
      targetStore,
      previews,
      github,
      reviews: store,
      ruleset: getDefaultRuleset(),
      compilerOptions: { generatedAt: options.now },
      submit: (input) => submit.submit(input),
    });
  })();

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
        // Enumeration never throws on a missing/unreadable tree. Session counts
        // come from the adapter's cheap one-pass counter (no transcript reads).
        const counts = adapter.countSessionsByProject?.(roots) ?? {};
        const projects = adapter
          .listProjects(roots)
          .map((p) => ({ ...annotateProject(p), sessionCount: counts[p.key] ?? 0 }));
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

        const { reviewId, state } = store.create(
          session,
          getDefaultRuleset(),
          { generatedAt: options.now },
          { sourceId, ref },
        );
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
      // Key-free provider list: allowlisted presets + custom/user-added targets.
      // Never returns key material (presets carry none; keys are resolved server-side).
      handler: () => ({ status: 200, json: { providers: listProviders(mergedTargets()) } }),
    },

    // ---- custom provider CRUD (provider-management) -----------------------
    {
      method: 'GET',
      pattern: '/api/custom-providers',
      // The persisted custom providers only (key-free by construction). The
      // allowlisted presets come from `/api/providers`; this route is the
      // editable subset the settings page manages.
      handler: () => ({ status: 200, json: { providers: providerStore.listCustomProviders() } }),
    },

    {
      method: 'POST',
      pattern: '/api/custom-providers',
      handler: ({ body }) => {
        const parsed = CustomProviderBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        // Reject an id that collides with an allowlisted preset: otherwise
        // `listProviders` would emit two rows with the same id and
        // `resolveProvider` (allowlist checked first) would return the preset,
        // silently shadowing the custom target — plus duplicate React keys/testids
        // in the settings UI. Same 409/PROVIDER_EXISTS shape as a custom-id clash.
        if (ALLOWED_PRESET_IDS.includes(parsed.data.id)) {
          return {
            status: 409,
            json: {
              error: `a built-in preset provider with id "${parsed.data.id}" already exists`,
              code: 'PROVIDER_EXISTS',
            },
          };
        }
        try {
          const created = providerStore.createCustomProvider(parsed.data);
          return { status: 201, json: { provider: created } };
        } catch (err) {
          if (err instanceof ProviderConflictError) {
            return { status: 409, json: { error: err.message, code: 'PROVIDER_EXISTS' } };
          }
          throw err;
        }
      },
    },

    {
      method: 'PUT',
      pattern: '/api/custom-providers/:id',
      handler: ({ params, body }) => {
        const parsed = CustomProviderUpdateBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        const updated = providerStore.updateCustomProvider(params.id, parsed.data);
        if (!updated) return notFound(`unknown custom provider "${params.id}"`);
        return { status: 200, json: { provider: updated } };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/custom-providers/:id',
      handler: ({ params }) => {
        const removed = providerStore.deleteCustomProvider(params.id);
        if (!removed) return notFound(`unknown custom provider "${params.id}"`);
        return { status: 200, json: { deleted: true } };
      },
    },

    // ---- write-only provider API-key management (provider-management) ------
    {
      method: 'GET',
      pattern: '/api/provider-keys',
      // Status ONLY — per-provider `configured: boolean`. NEVER key bytes.
      handler: () => ({ status: 200, json: { status: providerStore.keyStatus() } }),
    },

    {
      method: 'PUT',
      pattern: '/api/provider-keys/:providerId',
      handler: ({ params, body }) => {
        const parsed = ProviderKeyBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        // Encrypted at rest by the store; the response NEVER echoes the key.
        providerStore.setKey(params.providerId, parsed.data.apiKey);
        return { status: 200, json: { configured: true } };
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/provider-keys/:providerId',
      handler: ({ params }) => {
        providerStore.deleteKey(params.providerId);
        // Idempotent: deleting an absent key still ends configured:false.
        return { status: 200, json: { configured: false } };
      },
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
        if (providerId && !resolveProvider(providerId, mergedTargets())) {
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

        // ---- NO-FALLBACK BRANCH ---------------------------------------
        // Branch on consent.replayMode BEFORE any side effect. cli-resume goes
        // through @mosga/replay-submit (request-authenticity path); single-shot
        // / turn-by-turn through the existing reconstructed-API submit(). A
        // cli-resume failure returns a terminal HTTP error and NEVER falls
        // through to the reconstructed path. This explicit branch is the third
        // level of the no-fallback guarantee (structural + runtime + handler).
        const consentMode = readConsentReplayMode(body);
        if (consentMode === 'cli-resume') {
          return handleCliResumeSubmit({
            body,
            options,
            replayRuntime: options.replayRuntime,
            replayProxy: options.replayProxy,
            resolveApiKey: (id) =>
              resolveProviderKey(id, {
                keyConfigPath: options.providerKeyConfigPath,
                storeKeyLookup: (pid) => providerStore.getKey(pid),
              }),
            resolveTarget: (id) => resolveProvider(id, mergedTargets()),
            now: options.now,
            reviewId: params.reviewId,
          });
        }

        // ---- Reconstructed-API compatibility path (UNCHANGED) --------
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
        const target = resolveProvider(providerId, mergedTargets());
        if (!target) return notFound(`unknown provider "${providerId}"`);

        // Key is read server-side; a missing key is a config error, not a leak.
        // The user-scope store is the LAST precedence tier (env/startup win).
        const apiKey = resolveProviderKey(providerId, {
          keyConfigPath: options.providerKeyConfigPath,
          storeKeyLookup: (id) => providerStore.getKey(id),
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

    // ---- replay preparation (cli-resume bundle pipeline) ------------------
    // The prepare → triage → seal flow produces the sealed ReplayBundle the
    // cli-resume submit branch consumes. Additive to the existing submit +
    // compatibility routes; never creates a parallel submit path.

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/replay/prepare',
      handler: ({ params, body }) => {
        const state = store.get(params.reviewId);
        if (!state) return notFound(`unknown review "${params.reviewId}"`);
        const parsed = ReplayPrepareBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);

        // The source ref is required to call captureNativeSession. Reviews
        // created before this field existed have no ref — fail closed.
        const source = state.source;
        if (!source) {
          return {
            status: 409,
            json: {
              error: 'replay preparation requires a held source-session ref (re-create the review)',
              code: 'SOURCE_REF_UNAVAILABLE',
            },
          };
        }
        const adapter = getAdapter(source.sourceId);
        if (!adapter) return notFound(`unknown source "${source.sourceId}"`);

        // 1. Native capture — fail closed on any error (malformed, partial,
        // compressed). Never inherits the normalized readers' skip-and-continue.
        const capture = adapter.captureNativeSession(source.ref);
        if (!capture.ok) {
          return {
            status: 422,
            json: {
              error: capture.error.message,
              code: 'CAPTURE_FAILED',
              captureError: capture.error.code,
              sourceCli: capture.error.sourceCli,
            },
          };
        }

        // 2. Discover instruction candidates from the project cwd (v1: scan
        // CLAUDE.md / AGENTS.md in the session's cwd only — conservative).
        const candidates = discoverInstructionCandidates(source.ref.cwd);
        const omissions = buildInitialOmissions(candidates.length);
        const delivery = {
          schemaVersion: '1.0.0' as const,
          targetProviderId: parsed.data.targetProviderId,
          targetModel: parsed.data.targetModel,
        };
        const ruleset = getDefaultRuleset();
        const sanitization = buildSanitizationProvenance(
          ruleset.rulesetVersion,
          REPLAY_REPORT_VERSION,
        );

        // 3. Build the terminal-manifest seed + fixed v1 runtime policy from
        // the capture's safe source summary, trajectory, and delivery target.
        const seed = buildTerminalManifestSeed(capture, delivery, sanitization);
        const runtimePolicy = buildReplayRuntimePolicy(capture);

        // 4. Create the replay draft. A construction error (identity mismatch,
        // invalid candidate, unsafe stage path) is fail-closed.
        const draftId = newDraftId();
        let draft;
        try {
          draft = createReplayDraft({
            draftId,
            nativeCapture: capture,
            instructionCandidates: candidates,
            terminalManifestSeed: seed,
            runtimePolicy,
            delivery,
            omissions,
          });
        } catch (err) {
          return {
            status: 422,
            json: {
              error: 'replay draft construction failed',
              code: 'DRAFT_INVALID',
              detail: (err as Error).message,
            },
          };
        }

        // 5. Scan the draft with the shared compiled ruleset.
        const scan = scanReplayDraft(draft, ruleset, { generatedAt: options.now });
        if (!scan.ok) {
          return {
            status: 422,
            json: {
              error: scan.error.message,
              code: 'SCAN_FAILED',
              scanError: scan.error.code,
            },
          };
        }

        // 6. Hold the draft + report + mapper + ruleset server-side. The mapper
        // and ruleset are the exact pair apply needs at seal time — never mix
        // a draft/report/mapper from separate review runs.
        const replay: ReplayReviewState = {
          draft,
          report: scan.report,
          mapper: scan.mapper,
          ruleset,
          rulesetVersion: ruleset.rulesetVersion,
          reportVersion: REPLAY_REPORT_VERSION,
          delivery,
          rulesetWarnings: scan.rulesetWarnings,
        };
        store.setReplay(params.reviewId, replay);

        return {
          status: 201,
          json: {
            draftId,
            report: scan.report,
            rulesetWarnings: scan.rulesetWarnings,
            delivery,
            source: capture.source,
            trajectory: capture.trajectory,
          },
        };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/replay/findings/:findingId/disposition',
      handler: ({ params, body }) => {
        const replay = store.getReplay(params.reviewId);
        if (!replay) return notFound(`no replay preparation for review "${params.reviewId}"`);
        const parsed = ReplayFindingDispositionBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        if (!replay.report.findings.some((f) => f.id === params.findingId)) {
          return notFound(`unknown replay finding "${params.findingId}"`);
        }
        const report = setReplayFindingDisposition(
          replay.report,
          params.findingId,
          parsed.data.disposition,
        );
        store.setReplayReport(params.reviewId, report);
        return { status: 200, json: { report, gate: report.gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/replay/opaque/:itemId/disposition',
      handler: ({ params, body }) => {
        const replay = store.getReplay(params.reviewId);
        if (!replay) return notFound(`no replay preparation for review "${params.reviewId}"`);
        const parsed = ReplayOpaqueDispositionBody.safeParse(body);
        if (!parsed.success) return badRequest(parsed.error.message);
        if (!replay.report.opaqueItems.some((i) => i.id === params.itemId)) {
          return notFound(`unknown replay opaque item "${params.itemId}"`);
        }
        if (parsed.data.disposition === 'replace' && parsed.data.replacement === undefined) {
          return badRequest('a replace disposition requires an explicit JSON replacement');
        }
        const report = setReplayOpaqueDisposition(
          replay.report,
          params.itemId,
          parsed.data.disposition,
          parsed.data.replacement ?? null,
        );
        store.setReplayReport(params.reviewId, report);
        return { status: 200, json: { report, gate: report.gate } };
      },
    },

    {
      method: 'POST',
      pattern: '/api/reviews/:reviewId/replay/seal',
      handler: ({ params }) => {
        const replay = store.getReplay(params.reviewId);
        if (!replay) return notFound(`no replay preparation for review "${params.reviewId}"`);

        // The replay gate must be unlocked before sealing is permitted. The
        // gate is recomputed from the held findings + opaque items (last-write-
        // wins discipline means a transient desync stays MORE locked).
        if (!replay.report.gate.unlocked) {
          return {
            status: 409,
            json: {
              error: 'replay gate is locked; disposition all blocking findings + opaque items first',
              code: 'REPLAY_GATE_LOCKED',
              gate: replay.report.gate,
            },
          };
        }

        // Apply the reviewed dispositions. Binds the draft id, canonical draft-
        // content hash, expected ruleset version, compiled ruleset, terminal-
        // seed provenance, report, and the replay-scoped pseudonym mapper
        // returned by the matching scan — never a mix from separate runs.
        const applied = applyReplayDispositions(replay.draft, replay.report, replay.mapper, {
          ruleset: replay.ruleset,
          expectedRulesetVersion: replay.rulesetVersion,
          decisionVersion: newDecisionVersion(),
          approvedAt: options.now ?? new Date().toISOString(),
        });
        if (!applied.ok) {
          return {
            status: 422,
            json: {
              error: applied.error.message,
              code: 'APPLY_FAILED',
              applyError: applied.error.code,
              findingId: applied.error.findingId,
            },
          };
        }
        if (!applied.sealablePayload) {
          // The gate was unlocked but the post-apply verification found a
          // surviving blocking canary or unresolved privacy decision. This is
          // fail-closed by construction — no sealed bundle is produced.
          return {
            status: 409,
            json: {
              error: 'replay review resolved to a non-sealable payload (unresolved blocking or privacy finding)',
              code: 'NOT_SEALABLE',
              gate: applied.gate,
            },
          };
        }

        // Seal the reviewed payload → the bundle the cli-resume submit consumes.
        const bundle = sealReplayBundle(applied.sealablePayload);
        store.setSealedBundle(params.reviewId, bundle);

        return {
          status: 200,
          json: {
            bundle,
            bundleContentHash: bundle.integrity.contentHash,
            summary: {
              draftId: replay.draft.draftId,
              sourceCli: replay.draft.source.sourceCli,
              trajectory: replay.draft.terminalManifestSeed.trajectory,
              instructionCount: replay.draft.instructionSnapshot.files.length,
              findingCount: replay.report.findings.length,
              opaqueItemCount: replay.report.opaqueItems.length,
            },
          },
        };
      },
    },

    // ---- canonical GitHub publication target / preview / submit ------------
    ...createPublishRoutes(publication),
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

    if (isMutatingMethod(req.method)) {
      const contentType = req.headers['content-type'];
      if (
        typeof contentType !== 'string' ||
        !/^application\/json(?:\s*;\s*charset=[^;]+)?\s*$/i.test(contentType)
      ) {
        sendJson(res, 415, {
          error: 'application/json is required for mutating requests',
          code: 'UNSUPPORTED_MEDIA_TYPE',
        });
        return;
      }
      const fetchSite = req.headers['sec-fetch-site'];
      if (
        typeof fetchSite === 'string' &&
        fetchSite.toLowerCase() === 'cross-site'
      ) {
        sendJson(res, 403, {
          error: 'cross-site request forbidden',
          code: 'FORBIDDEN_ORIGIN',
        });
        return;
      }
      const origin = req.headers.origin;
      const expectedOrigin = req.headers.host
        ? `http://${req.headers.host}`
        : undefined;
      if (
        origin !== undefined &&
        (typeof origin !== 'string' ||
          expectedOrigin === undefined ||
          origin !== expectedOrigin)
      ) {
        sendJson(res, 403, {
          error: 'origin forbidden',
          code: 'FORBIDDEN_ORIGIN',
        });
        return;
      }
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
    } catch {
      sendJson(res, 500, {
        error: 'internal server error',
        code: 'INTERNAL_ERROR',
      });
    }
  }

  return { store, publication, requestListener };
}

function isMutatingMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function notFound(message: string): HandlerResult {
  return { status: 404, json: { error: message } };
}

function badRequest(message: string): HandlerResult {
  return { status: 400, json: { error: message } };
}

/** Hostnames the loopback API accepts (DNS-rebinding guard). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** True when a request's `Host` header names the loopback interface only. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (
    !hostHeader ||
    hostHeader.length > 255 ||
    /[\u0000-\u0020\u007f]/.test(hostHeader)
  ) {
    return false;
  }
  const ipv6 = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(hostHeader);
  if (ipv6) {
    return ipv6[1].toLowerCase() === '::1' && validHostPort(ipv6[2]);
  }
  const host = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(hostHeader);
  return (
    host !== null &&
    LOOPBACK_HOSTNAMES.has(host[1].toLowerCase()) &&
    validHostPort(host[2])
  );
}

function validHostPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
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

// -----------------------------------------------------------------------
// Cli-resume submit helpers (出口② request-authenticity path)
// -----------------------------------------------------------------------

/** Read `consent.replayMode` from the raw body WITHOUT validating the full schema. */
function readConsentReplayMode(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object') {
    const consent = (body as { consent?: { replayMode?: string } }).consent;
    if (consent && typeof consent === 'object') {
      return consent.replayMode;
    }
  }
  return undefined;
}

/** Map the direct-submit API format to the replay upstream API format. */
function mapToReplayApiFormat(
  apiFormat: string,
):
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses'
  | null {
  switch (apiFormat) {
    case 'anthropic':
      return 'anthropic-messages';
    case 'openai':
      return 'openai-chat-completions';
    case 'openai-response':
      return 'openai-responses';
    default:
      return null;
  }
}

interface CliResumeHandlerContext {
  readonly body: unknown;
  readonly options: AppOptions;
  readonly replayRuntime: ReplayRuntime | undefined;
  readonly replayProxy: ReplayProxy | undefined;
  readonly resolveApiKey: (providerId: string) => string | undefined;
  readonly resolveTarget: (providerId: string) => { apiBaseUrl: string; apiFormat: string } | undefined;
  readonly now: string | undefined;
  readonly reviewId: string;
}

/**
 * Handle a cli-resume submission via @mosga/replay-submit. A cli-resume failure
 * returns a terminal HTTP error and NEVER falls through to the reconstructed-API
 * submit() path.
 */
async function handleCliResumeSubmit(ctx: CliResumeHandlerContext): Promise<HandlerResult> {
  const parsed = CliResumeSubmitBody.safeParse(ctx.body);
  if (!parsed.success) return badRequest(parsed.error.message);

  const { providerId, model, consent, bundle } = parsed.data;

  // Runtime + proxy must be configured for cli-resume. If they're absent, the
  // daemon was not started with replay support — return a configuration error,
  // not a fallback.
  if (!ctx.replayRuntime || !ctx.replayProxy) {
    return {
      status: 500,
      json: { error: 'cli-resume replay runtime/proxy not configured', code: 'SUBMIT_FAILED' },
    };
  }

  // Resolve the upstream target + key (same provider store as the reconstructed path).
  const target = ctx.resolveTarget(providerId);
  if (!target) return notFound(`unknown provider "${providerId}"`);
  const apiKey = ctx.resolveApiKey(providerId);
  if (!apiKey) {
    return { status: 400, json: { error: `no API key configured for provider "${providerId}"`, code: 'KEY_NOT_CONFIGURED' } };
  }
  const replayFormat = mapToReplayApiFormat(target.apiFormat);
  if (!replayFormat) {
    return {
      status: 422,
      json: { error: `provider API format "${target.apiFormat}" is not supported for cli-resume`, code: 'BUNDLE_INVALID' },
    };
  }

  const upstream: ReplayUpstreamTarget = {
    targetProviderId: providerId,
    targetModel: model,
    upstreamBaseUrl: target.apiBaseUrl,
    upstreamApiKey: apiKey,
    upstreamApiFormat: replayFormat,
  };

  const result = await submitCliResume({
    bundle,
    consent,
    upstream,
    runtime: ctx.replayRuntime,
    proxy: ctx.replayProxy,
    now: ctx.now ? () => ctx.now! : undefined,
  });

  if (result.ok) {
    return { status: 200, json: { receipt: result.receipt } };
  }

  // Map the orchestration failure to stable HTTP codes. NEVER fall through to
  // the reconstructed-API path.
  return mapCliResumeFailure(result.error);
}

/** Map a CliResumeSubmitFailure to a stable HTTP error response. */
function mapCliResumeFailure(error: {
  readonly code: string;
  readonly sourceCli: string | null;
  readonly replayCliVersion: string | null;
  readonly stage: string;
}): HandlerResult {
  switch (error.code) {
    case 'consent-invalid':
      return { status: 422, json: { error: 'cli-resume consent validation failed', code: 'CONSENT_INVALID' } };
    case 'bundle-invalid':
      return { status: 422, json: { error: 'cli-resume bundle validation failed', code: 'BUNDLE_INVALID' } };
    case 'runtime-unsupported':
      return {
        status: 422,
        json: {
          error: `cli-resume runtime unsupported${error.sourceCli ? ` (source CLI: ${error.sourceCli})` : ''}${error.replayCliVersion ? ` — installed version ${error.replayCliVersion} is not supported; install or update the required CLI` : ''}`,
          code: 'RUNTIME_UNSUPPORTED',
          sourceCli: error.sourceCli,
          replayCliVersion: error.replayCliVersion,
        },
      };
    case 'runtime-failed':
      return { status: 500, json: { error: 'cli-resume runtime failure', code: 'RUNTIME_FAILED' } };
    case 'proxy-failed':
      return { status: 500, json: { error: 'cli-resume proxy failure', code: 'PROXY_FAILED' } };
    case 'upstream-failed':
      return { status: 500, json: { error: 'cli-resume upstream failure', code: 'PROXY_FAILED' } };
    case 'cancelled':
      return { status: 499, json: { error: 'cli-resume cancelled', code: 'SUBMIT_FAILED' } };
    case 'timed-out':
      return { status: 504, json: { error: 'cli-resume timed out', code: 'SUBMIT_FAILED' } };
    default:
      console.error('[cli-resume] unexpected failure code:', error.code, 'at stage:', error.stage);
      return { status: 500, json: { error: 'cli-resume submission failed', code: 'SUBMIT_FAILED' } };
  }
}
