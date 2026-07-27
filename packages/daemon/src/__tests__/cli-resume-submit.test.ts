/**
 * Daemon cli-resume submit tests:
 * - E2e happy path (cli-resume produces a CliResumeReceipt with three hashes)
 * - No-fallback guarantee (a cli-resume failure does NOT call submit())
 * - Compatibility (reconstructed-API path still works under single-shot)
 *
 * All fakes — no real CLI, listener, or provider.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CliResumeConsent,
  ReplayBundle,
  SourceCli,
} from '@mosga/contracts';
import { sealReplayBundle } from '@mosga/replay-bundle';
import type {
  PreparedReplay,
  ReplayExecutionResult,
  ReplayPreparationObservation,
  ReplayPrepareResult,
  ReplayRuntime,
  ReplayRouteRequirement,
} from '@mosga/replay-runtime';
import type {
  ReplayProxy,
  ReplayProxyReceipt,
  ReplayRouteHandle,
  ReplayRouteRegistration,
} from '@mosga/replay-proxy';
import type { OutboundRequest } from '@mosga/direct-submit';

import {
  makeReviewedPayload,
  refreshReviewedDraftHash,
} from '../../../replay-bundle/src/__tests__/fixtures.js';
import { makeTempDir, plainTurn, rm, withServer, writeSession } from './_helpers';

const NOW = '2026-07-27T00:00:00.000Z';
const FAKE_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

// -----------------------------------------------------------------------
// Sealed bundle fixture (uses deepseek as the delivery target so consent
// matches the upstream provider the daemon resolves)
// -----------------------------------------------------------------------

function sealedBundle(): ReplayBundle {
  const payload = refreshReviewedDraftHash(makeReviewedPayload());
  // Align the bundle's delivery with the daemon test provider.
  payload.delivery.targetProviderId = 'deepseek';
  payload.delivery.targetModel = 'deepseek-chat';
  payload.terminalManifestSeed.delivery.targetProviderId = 'deepseek';
  payload.terminalManifestSeed.delivery.targetModel = 'deepseek-chat';
  return sealReplayBundle(refreshReviewedDraftHash(payload));
}

function bundleHash(bundle: ReplayBundle): `sha256:${string}` {
  return bundle.integrity.contentHash as `sha256:${string}`;
}

function validConsent(bundle: ReplayBundle): CliResumeConsent {
  return {
    consentVersion: 'cli-resume-0.1.0',
    tosRiskAcknowledged: true,
    fullRetentionAcknowledged: true,
    runtimeContextAcknowledged: true,
    bundleContentHash: bundleHash(bundle),
    targetProviderId: 'deepseek',
    targetModel: 'deepseek-chat',
    replayMode: 'cli-resume',
    instructionPolicy: 'sanitized-snapshot',
    skillPolicy: 'cli-discovery-read-only',
    confirmedAt: NOW,
  };
}

// -----------------------------------------------------------------------
// Fake runtime + proxy �� observation hash matches the real sealed bundle
// -----------------------------------------------------------------------

function createDaemonFakes(
  bundleHash: `sha256:${string}`,
  config: { prepareFail?: boolean } = {},
): { runtime: ReplayRuntime; proxy: ReplayProxy } {
  const observation: ReplayPreparationObservation = {
    sourceCli: 'claude-code' as SourceCli,
    bundleContentHash: bundleHash,
    recordedCliVersion: '1.2.3',
    replayCliVersion: '1.2.3',
    capabilityProfileId: 'claude-code-2.1-headless-resume-v1',
    delivery: {
      schemaVersion: '1.0.0',
      targetProviderId: 'deepseek',
      targetModel: 'deepseek-chat',
    },
    routeRequirement: {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'deepseek',
      targetModel: 'deepseek-chat',
    } as ReplayRouteRequirement,
  };

  const prepared: PreparedReplay = {
    observation,
    async execute(): Promise<ReplayExecutionResult> {
      return {
        ok: true,
        observation,
        startedAt: NOW,
        completedAt: NOW,
        durationMs: 100,
        exitStatus: 0,
      };
    },
    async dispose() {
      return { ok: true, cleanup: 'complete' as const };
    },
  };

  const prepareResult: ReplayPrepareResult = config.prepareFail
    ? {
        ok: false,
        error: {
          code: 'cli-version-unsupported',
          stage: 'probe',
          sourceCli: 'claude-code',
          replayCliVersion: '1.2.3',
          cleanup: 'not-created',
        },
      }
    : { ok: true, prepared };

  const runtime: ReplayRuntime = {
    async prepare() {
      return prepareResult;
    },
  };

  const receipt: ReplayProxyReceipt = {
    sourceCli: 'claude-code',
    sourceWireProtocol: 'anthropic-messages',
    targetProviderId: 'deepseek',
    targetModel: 'deepseek-chat',
    upstreamApiFormat: 'openai-chat-completions',
    converterId: 'anthropic-to-openai-chat',
    converterVersion: '1.0.0',
    cliRequestHash: 'sha256:' + 'b'.repeat(64),
    outboundRequestHash: 'sha256:' + 'c'.repeat(64),
    requestCount: 1,
    httpStatus: 200,
    outcome: 'inference-served',
    usage: { inputTokens: 100, outputTokens: 50 },
    startedAt: NOW,
    completedAt: NOW,
    durationMs: 100,
    routeClosed: 'single-shot-completed',
  };

  const handle: ReplayRouteHandle = {
    binding: {
      sourceCli: 'claude-code',
      wireProtocol: 'anthropic-messages',
      transport: 'loopback-http',
      authScheme: 'route-bearer',
      targetProviderId: 'deepseek',
      targetModel: 'deepseek-chat',
      baseUrl: 'http://127.0.0.1:9999',
      routeToken: 'fake-token',
      cliModel: 'deepseek-chat',
    },
    receipt: Promise.resolve(receipt),
    async dispose() {
      return { ok: true, routeClosed: 'disposed-unused' as const };
    },
  };

  const registration: ReplayRouteRegistration = { ok: true, handle };

  const proxy: ReplayProxy = {
    async registerRoute(): Promise<ReplayRouteRegistration> {
      return registration;
    },
    async shutdown() {
      return { ok: true, routesClosed: 0 };
    },
  };

  return { runtime, proxy };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('cli-resume daemon submit route', () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempDir('mosga-home-');
    cwd = makeTempDir('mosga-cwd-');
    writeSession(home, 'projX', 'sess-projX', cwd, [plainTurn('u1')]);
  });

  afterEach(() => {
    rm(home);
    rm(cwd);
  });

  it('cli-resume happy path returns a CliResumeReceipt with three hashes', async () => {
    const bundle = sealedBundle();
    const hash = bundleHash(bundle);
    const consent = validConsent(bundle);
    const fakes = createDaemonFakes(hash);

    const keyDir = makeTempDir('mosga-key-');
    const keyConfigPath = path.join(keyDir, 'keys.json');
    fs.writeFileSync(keyConfigPath, JSON.stringify({ deepseek: FAKE_KEY }), 'utf-8');

    await withServer(
      {
        homeDir: home,
        providerKeyConfigPath: keyConfigPath,
        replayRuntime: fakes.runtime,
        replayProxy: fakes.proxy,
        now: NOW,
      },
      async (base) => {
        const reviewRes = await fetch(`${base}/api/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceId: 'claude-code',
            projectKey: 'projX',
            sessionId: 'sess-projX',
          }),
        });
        const review = (await reviewRes.json()) as { reviewId: string };

        const res = await fetch(`${base}/api/reviews/${review.reviewId}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'deepseek',
            model: 'deepseek-chat',
            consent,
            bundle,
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          receipt: {
            bundleContentHash: string;
            cliRequestHash: string;
            outboundRequestHash: string;
            outcome: string;
            sourceCli: string;
          };
        };
        expect(body.receipt.bundleContentHash).toMatch(/^sha256:/);
        expect(body.receipt.cliRequestHash).toMatch(/^sha256:/);
        expect(body.receipt.outboundRequestHash).toMatch(/^sha256:/);
        expect(body.receipt.outcome).toBe('inference-served');
        expect(body.receipt.sourceCli).toBe('claude-code');
      },
    );
    rm(keyDir);
  });

  it('cli-resume failure does NOT fall through to reconstructed API submit()', async () => {
    const bundle = sealedBundle();
    const hash = bundleHash(bundle);
    const consent = validConsent(bundle);
    const fakes = createDaemonFakes(hash, { prepareFail: true });

    const keyDir = makeTempDir('mosga-key-');
    const keyConfigPath = path.join(keyDir, 'keys.json');
    fs.writeFileSync(keyConfigPath, JSON.stringify({ deepseek: FAKE_KEY }), 'utf-8');

    // Track whether the reconstructed-API transport is ever called.
    const transportCalls: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      transportCalls.push(req);
      return { status: 200, body: new Uint8Array() };
    };

    await withServer(
      {
        homeDir: home,
        providerKeyConfigPath: keyConfigPath,
        replayRuntime: fakes.runtime,
        replayProxy: fakes.proxy,
        submitTransport,
        now: NOW,
      },
      async (base) => {
        const reviewRes = await fetch(`${base}/api/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceId: 'claude-code',
            projectKey: 'projX',
            sessionId: 'sess-projX',
          }),
        });
        const review = (await reviewRes.json()) as { reviewId: string };

        const res = await fetch(`${base}/api/reviews/${review.reviewId}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'deepseek',
            model: 'deepseek-chat',
            consent,
            bundle,
          }),
        });

        // The failure returns a terminal error with RUNTIME_UNSUPPORTED.
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; sourceCli?: string };
        expect(body.code).toBe('RUNTIME_UNSUPPORTED');
        expect(body.sourceCli).toBe('claude-code');

        // The reconstructed-API transport was NEVER called.
        expect(transportCalls).toHaveLength(0);
      },
    );
    rm(keyDir);
  });

  it('compatibility: single-shot still routes through the existing submit() path', async () => {
    const keyDir = makeTempDir('mosga-key-');
    const keyConfigPath = path.join(keyDir, 'keys.json');
    fs.writeFileSync(keyConfigPath, JSON.stringify({ deepseek: FAKE_KEY }), 'utf-8');

    const transportCalls: OutboundRequest[] = [];
    const submitTransport = async (req: OutboundRequest) => {
      transportCalls.push(req);
      return {
        status: 200,
        body: new Uint8Array(
          Buffer.from(JSON.stringify({
            id: 'fake',
            model: 'deepseek-chat',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          })),
        ),
      };
    };

    await withServer(
      {
        homeDir: home,
        providerKeyConfigPath: keyConfigPath,
        submitTransport,
        now: NOW,
      },
      async (base) => {
        const reviewRes = await fetch(`${base}/api/reviews`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceId: 'claude-code',
            projectKey: 'projX',
            sessionId: 'sess-projX',
          }),
        });
        const review = (await reviewRes.json()) as {
          reviewId: string;
          report: { findings: Array<{ id: string; blocking: boolean }>; nonTextItems: unknown[] };
        };

        // Unlock the gate.
        for (const f of review.report.findings.filter((x) => x.blocking)) {
          await fetch(`${base}/api/reviews/${review.reviewId}/findings/${f.id}/disposition`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disposition: 'replace' }),
          });
        }

        // Estimate first (needed for consent contentHash).
        const estRes = await fetch(`${base}/api/reviews/${review.reviewId}/submit/estimate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ providerId: 'deepseek', model: 'deepseek-chat', replayMode: 'single-shot' }),
        });
        const est = (await estRes.json()) as { contentHash: string; totalTokens: number };

        // Submit via single-shot (reconstructed API).
        const res = await fetch(`${base}/api/reviews/${review.reviewId}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            providerId: 'deepseek',
            model: 'deepseek-chat',
            consent: {
              consentVersion: '0.2.0',
              tosRiskAcknowledged: true,
              fullRetentionAcknowledged: true,
              targetProviderId: 'deepseek',
              targetModel: 'deepseek-chat',
              replayMode: 'single-shot',
              estimatedTokens: est.totalTokens,
              contentHash: est.contentHash,
              confirmedAt: NOW,
            },
          }),
        });

        expect(res.status).toBe(200);
        expect(transportCalls.length).toBeGreaterThanOrEqual(1);
      },
    );
    rm(keyDir);
  });
});
