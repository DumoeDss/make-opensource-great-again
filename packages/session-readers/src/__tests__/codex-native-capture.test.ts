import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CliSessionRef } from '@mosga/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { codexAdapter } from '../adapter/codexAdapter.js';

const root = mkdtempSync(path.join(tmpdir(), 'mosga-codex-native-'));
const transcriptPath = path.join(root, 'rollout-session.jsonl');
const compressedPath = path.join(root, 'rollout-session.jsonl.zst');
const malformedPath = path.join(root, 'rollout-malformed.jsonl');
const providerAbsentPath = path.join(root, 'provider-absent.jsonl');
const alternateProviderPath = path.join(root, 'alternate-provider.jsonl');

const rows = [
  {
    type: 'session_meta',
    payload: {
      id: 'private-native-id',
      cwd: '/Users/private/repository',
      cli_version: '0.99.0',
      model_provider: 'openai',
      originator: 'cli',
      mode: 'interactive',
      git: { branch: 'private-feature', commit: 'deadbeef' },
    },
  },
  {
    type: 'turn_context',
    payload: {
      model: 'gpt-fake-a',
      reasoning_effort: 'high',
      model_context_window: 200_000,
      base_instructions: 'private instructions are retained only natively',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'fake prompt' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'fake response' }],
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: 'fake response mirror',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: 'tool-1',
      name: 'read_file',
      arguments: '{"path":"fake.txt"}',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'tool-1',
      output: 'fake result',
    },
  },
  {
    type: 'turn_context',
    payload: {
      model: 'gpt-fake-b',
      reasoning_effort: 'low',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'second response' }],
    },
  },
  {
    type: 'compacted',
    payload: { message: 'fake compacted summary' },
  },
  {
    type: 'future-row',
    payload: { unknown: [1, true, null], reference: 'tool-1' },
  },
];

writeFileSync(
  transcriptPath,
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  'utf8',
);
writeFileSync(compressedPath, 'obviously fake compressed bytes', 'utf8');
writeFileSync(
  malformedPath,
  `${JSON.stringify({ type: 'session_meta', payload: { id: 'fake' } })}\nprivate late malformed canary\n`,
  'utf8',
);
writeFileSync(
  providerAbsentPath,
  [
    {
      type: 'turn_context',
      payload: { model: 'gpt-fake-no-provider' },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [] },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
);
writeFileSync(
  alternateProviderPath,
  [
    {
      type: 'session_meta',
      payload: { model_provider: 'azure-openai' },
    },
    {
      type: 'turn_context',
      payload: { model: 'gpt-fake-azure' },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [] },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ref: CliSessionRef = {
  sourceId: 'codex',
  projectKey: 'fake-project',
  id: 'session-alias',
  path: transcriptPath,
  title: 'Private title must not be summarized',
  cwd: '/Users/private/repository',
  updatedAt: 1,
  sizeBytes: 1,
};

describe('Codex strict native capture', () => {
  it('retains session/context/response/event/compacted/unknown rows in order', () => {
    const before = readFileSync(transcriptPath, 'utf8');
    const result = codexAdapter.captureNativeSession(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.files[0]!.rows.map((row) => row.value)).toEqual(rows);
    expect(result.artifact.files[0]!.rows.map((row) => row.ordinal)).toEqual(
      rows.map((_, index) => index),
    );
    expect(readFileSync(transcriptPath, 'utf8')).toBe(before);
  });

  it('derives turn-context model timelines without counting event mirrors', () => {
    const result = codexAdapter.captureNativeSession(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.source).toMatchObject({
      recordedCliVersion: '0.99.0',
      modelProvider: 'openai',
      sourceModels: ['gpt-fake-a', 'gpt-fake-b'],
      contextWindow: 200_000,
      sessionMode: 'interactive',
      entrypoint: 'terminal',
    });
    expect(result.source.modelTimeline).toEqual([
      {
        assistantTurnIndex: 0,
        model: 'gpt-fake-a',
        effort: 'high',
      },
      {
        assistantTurnIndex: 1,
        model: 'gpt-fake-b',
        effort: 'low',
      },
    ]);
    expect(result.trajectory).toEqual({
      schemaVersion: '1.0.0',
      totalRows: rows.length,
      userTurns: 1,
      assistantTurns: 2,
      toolCalls: 1,
      toolResults: 1,
      compactedEvents: 1,
    });

    const safeProjection = JSON.stringify({
      source: result.source,
      trajectory: result.trajectory,
    });
    expect(safeProjection).not.toContain('/Users/private/repository');
    expect(safeProjection).not.toContain('private-feature');
    expect(safeProjection).not.toContain('private instructions');
  });

  it('keeps an absent provider null and preserves an explicit alternate provider', () => {
    const absent = codexAdapter.captureNativeSession({
      ...ref,
      path: providerAbsentPath,
    });
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.source.modelProvider).toBeNull();
    expect(absent.source.sourceModels).toEqual(['gpt-fake-no-provider']);

    const alternate = codexAdapter.captureNativeSession({
      ...ref,
      path: alternateProviderPath,
    });
    expect(alternate.ok).toBe(true);
    if (!alternate.ok) return;
    expect(alternate.source.modelProvider).toBe('azure-openai');
    expect(alternate.source.sourceModels).toEqual(['gpt-fake-azure']);
  });

  it('explicitly refuses compressed input without exposing bytes or paths', () => {
    const result = codexAdapter.captureNativeSession({
      ...ref,
      path: compressedPath,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { sourceCli: 'codex', code: 'unsupported-compression' },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(compressedPath);
    expect(serialized).not.toContain('obviously fake compressed bytes');
  });

  it('does not expose original paths or raw late-row content on failure', () => {
    const result = codexAdapter.captureNativeSession({
      ...ref,
      path: malformedPath,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { sourceCli: 'codex', code: 'malformed-jsonl' },
    });
    expect(result).not.toHaveProperty('artifact');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(malformedPath);
    expect(serialized).not.toContain('private late malformed canary');
  });
});
