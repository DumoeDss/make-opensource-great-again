// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type {
  ProviderTarget,
  ReplayPrepareResponse,
  ReplayReportResponse,
  ReplaySealResponse,
} from '../api/types';
import { ReplayPreparation } from '../components/ReplayPreparation';

afterEach(cleanup);

const PROVIDERS: ProviderTarget[] = [
  { id: 'deepseek', name: 'DeepSeek', apiFormat: 'openai', apiBaseUrl: 'https://x', models: ['deepseek-chat'] },
];

const BUNDLE_HASH = 'sha256:' + 'a'.repeat(64);

function prepareResponse(): ReplayPrepareResponse {
  return {
    draftId: 'replay-draft-test',
    report: {
      schemaVersion: '1.0.0',
      reportVersion: '1.0.0',
      draftId: 'replay-draft-test',
      draftContentHash: 'sha256:' + 'd'.repeat(64),
      sanitizationRulesetVersion: 'test-ruleset',
      generatedAt: '2026-07-27T00:00:00.000Z',
      findings: [],
      opaqueItems: [],
      layerSummary: {
        secrets: { total: 0, pending: 0 },
        custom: { total: 0, pending: 0 },
        normalization: { total: 0, byCategory: {} },
        guard: { total: 0, pending: 0 },
      },
      gate: {
        schemaVersion: '1.0.0',
        blockingTotal: 0,
        blockingPending: 0,
        opaquePending: 0,
        unlocked: true,
      },
    },
    rulesetWarnings: [],
    delivery: {
      schemaVersion: '1.0.0',
      targetProviderId: 'deepseek',
      targetModel: 'deepseek-chat',
    },
    source: {
      schemaVersion: '1.0.0',
      sourceCli: 'claude-code',
      sourceFormat: 'claude-code-jsonl',
      sessionIdAlias: 'session-1',
      recordedCliVersion: '1.2.3',
      modelProvider: 'anthropic',
      sourceModels: ['claude-fake'],
      modelTimeline: [],
      contextWindow: 200000,
      sessionMode: 'interactive',
      entrypoint: 'terminal',
    },
    trajectory: {
      schemaVersion: '1.0.0',
      totalRows: 2,
      userTurns: 1,
      assistantTurns: 1,
      toolCalls: 0,
      toolResults: 0,
      compactedEvents: 0,
    },
  };
}

function sealResponse(): ReplaySealResponse {
  // The bundle is opaque to the UI (it just passes it through to SubmitPanel).
  // Use a minimal mock with the integrity hash the test asserts on.
  return {
    bundle: {
      payload: { schemaVersion: '1.0.0' },
      integrity: {
        algorithm: 'sha256',
        canonicalization: 'mosga-replay-canonical-json-v1',
        entries: [],
        contentHash: BUNDLE_HASH,
      },
    } as unknown as ReplaySealResponse['bundle'],
    bundleContentHash: BUNDLE_HASH,
    summary: {
      draftId: 'replay-draft-test',
      sourceCli: 'claude-code',
      trajectory: {
        schemaVersion: '1.0.0',
        totalRows: 2,
        userTurns: 1,
        assistantTurns: 1,
        toolCalls: 0,
        toolResults: 0,
        compactedEvents: 0,
      },
      instructionCount: 0,
      findingCount: 0,
      opaqueItemCount: 0,
    },
  };
}

function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listProviders: vi.fn(async () => PROVIDERS),
    prepareReplay: vi.fn(async () => prepareResponse()),
    sealReplay: vi.fn(async () => ({ ok: true as const, data: sealResponse() })),
    setReplayFindingDisposition: vi.fn(async (): Promise<ReplayReportResponse> => {
      throw new Error('not expected');
    }),
    setReplayOpaqueDisposition: vi.fn(async (): Promise<ReplayReportResponse> => {
      throw new Error('not expected');
    }),
    ...over,
  } as unknown as ApiClient;
}

describe('ReplayPreparation', () => {
  it('prepare → seal flows the bundle + hash to onSealed', async () => {
    const onSealed = vi.fn();
    const client = fakeClient();
    const { findByTestId, getByTestId } = render(
      <ReplayPreparation client={client} reviewId="r1" onSealed={onSealed} />,
    );

    // Wait for providers to load on first interaction, then prepare.
    const prepareBtn = await findByTestId('replay-prep-prepare-btn');
    fireEvent.click(prepareBtn);

    // After prepare succeeds with a clean scan, the seal button appears.
    const sealBtn = await findByTestId('replay-prep-seal-btn');
    expect(sealBtn).toBeDefined();

    // Seal → onSealed fires with the bundle + hash.
    fireEvent.click(sealBtn);
    await waitFor(() => expect(onSealed).toHaveBeenCalledTimes(1));
    expect(onSealed).toHaveBeenCalledWith(
      expect.objectContaining({ integrity: expect.objectContaining({ contentHash: BUNDLE_HASH }) }),
      BUNDLE_HASH,
    );

    // The sealed indicator appears.
    const sealed = await findByTestId('replay-prep-sealed');
    expect(sealed.textContent).toContain('sealed');
    expect(sealed.textContent).toContain(BUNDLE_HASH);
  });

  it('prepare error surfaces the error message', async () => {
    const client = fakeClient({
      prepareReplay: vi.fn(async () => {
        throw new Error('CAPTURE_FAILED: malformed JSONL');
      }),
    });
    const { findByTestId } = render(
      <ReplayPreparation client={client} reviewId="r1" onSealed={vi.fn()} />,
    );

    const prepareBtn = await findByTestId('replay-prep-prepare-btn');
    fireEvent.click(prepareBtn);

    const err = await findByTestId('replay-prep-error');
    expect(err.textContent).toContain('CAPTURE_FAILED');
  });

  it('seal refusal surfaces the gate/code', async () => {
    const client = fakeClient({
      sealReplay: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        error: 'gate is locked',
        code: 'REPLAY_GATE_LOCKED',
      })),
    });
    const { findByTestId } = render(
      <ReplayPreparation client={client} reviewId="r1" onSealed={vi.fn()} />,
    );

    // Prepare first (clean scan → gate unlocked → seal button enabled).
    const prepareBtn = await findByTestId('replay-prep-prepare-btn');
    fireEvent.click(prepareBtn);
    const sealBtn = await findByTestId('replay-prep-seal-btn');
    fireEvent.click(sealBtn);

    const err = await findByTestId('replay-prep-error');
    expect(err.textContent).toContain('REPLAY_GATE_LOCKED');
  });
});
