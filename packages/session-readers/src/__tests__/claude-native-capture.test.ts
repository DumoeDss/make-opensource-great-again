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

import { claudeCodeAdapter } from '../adapter/claudeCodeAdapter.js';

const root = mkdtempSync(path.join(tmpdir(), 'mosga-claude-native-'));
const transcriptPath = path.join(root, 'session.jsonl');
const alternateProviderPath = path.join(root, 'alternate-provider.jsonl');

const rows = [
  {
    type: 'meta',
    version: '1.2.3',
    cwd: '/Users/private/repository',
    gitBranch: 'private-feature',
    entrypoint: 'cli',
    mode: 'interactive',
    contextWindow: 200_000,
  },
  {
    type: 'user',
    uuid: 'user-1',
    message: { role: 'user', content: 'fake prompt' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-1',
    parentUuid: 'user-1',
    message: {
      role: 'assistant',
      model: 'claude-fake-a',
      effort: 'high',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Read',
          input: { file: 'fake.txt' },
        },
      ],
    },
  },
  {
    type: 'user',
    uuid: 'tool-result-1',
    parentUuid: 'assistant-1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'fake result',
        },
      ],
    },
    unknownSibling: { reference: 'assistant-1' },
  },
  {
    type: 'assistant',
    uuid: 'assistant-2',
    message: {
      role: 'assistant',
      model: 'claude-fake-b',
      content: 'second response',
    },
  },
  {
    type: 'future-row',
    duplicateLogicalId: 'assistant-2',
    unknown: { keep: [1, true, null] },
  },
];

writeFileSync(
  transcriptPath,
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  'utf8',
);
writeFileSync(
  alternateProviderPath,
  [
    {
      type: 'meta',
      model_provider: 'amazon-bedrock',
    },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-fake-bedrock',
        content: 'fake alternate-provider response',
      },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ref: CliSessionRef = {
  sourceId: 'claude-code',
  projectKey: 'fake-project',
  id: 'session-alias',
  path: transcriptPath,
  title: 'Private title must not be summarized',
  cwd: '/Users/private/repository',
  updatedAt: 1,
  sizeBytes: 1,
};

describe('Claude Code strict native capture', () => {
  it('retains meta, tool-result, unknown, reference, and duplicate logical rows', () => {
    const before = readFileSync(transcriptPath, 'utf8');
    const result = claudeCodeAdapter.captureNativeSession(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifact.files[0]!.rows.map((row) => row.value)).toEqual(rows);
    expect(result.artifact.files[0]!.rows.map((row) => row.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(readFileSync(transcriptPath, 'utf8')).toBe(before);
  });

  it('extracts deterministic safe model/effort and trajectory context', () => {
    const result = claudeCodeAdapter.captureNativeSession(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.source).toMatchObject({
      recordedCliVersion: '1.2.3',
      modelProvider: null,
      sourceModels: ['claude-fake-a', 'claude-fake-b'],
      contextWindow: 200_000,
      sessionMode: 'interactive',
      entrypoint: 'terminal',
    });
    expect(result.source.modelTimeline).toEqual([
      {
        assistantTurnIndex: 0,
        model: 'claude-fake-a',
        effort: 'high',
      },
      {
        assistantTurnIndex: 1,
        model: 'claude-fake-b',
        effort: null,
      },
    ]);
    expect(result.trajectory).toEqual({
      schemaVersion: '1.0.0',
      totalRows: 6,
      userTurns: 2,
      assistantTurns: 2,
      toolCalls: 1,
      toolResults: 1,
      compactedEvents: 0,
    });

    const safeProjection = JSON.stringify({
      source: result.source,
      trajectory: result.trajectory,
    });
    expect(safeProjection).not.toContain('/Users/private/repository');
    expect(safeProjection).not.toContain('private-feature');
    expect(safeProjection).not.toContain('Private title');
  });

  it('keeps an absent provider null and preserves an explicit alternate provider', () => {
    const absent = claudeCodeAdapter.captureNativeSession(ref);
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.source.modelProvider).toBeNull();

    const alternate = claudeCodeAdapter.captureNativeSession({
      ...ref,
      path: alternateProviderPath,
    });
    expect(alternate.ok).toBe(true);
    if (!alternate.ok) return;
    expect(alternate.source.modelProvider).toBe('amazon-bedrock');
    expect(alternate.source.sourceModels).toEqual(['claude-fake-bedrock']);
  });
});
