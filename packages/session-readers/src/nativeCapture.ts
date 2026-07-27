import fs from 'node:fs';

import {
  NativeSessionArtifactSchema,
  type NativeCaptureFailure,
  type NativeCaptureErrorCode,
  type NativeCaptureResult,
  type NativeSessionArtifact,
  type ReplayTrajectory,
  type SafeSourceSummary,
  type SourceCli,
} from '@mosga/contracts';

export type NativeArtifactCaptureResult =
  | { ok: true; artifact: NativeSessionArtifact }
  | NativeCaptureFailure;

export interface StrictJsonlCaptureOptions {
  sourceCli: SourceCli;
  sourceFormat: NativeSessionArtifact['sourceFormat'];
  sessionIdAlias: string;
  transcriptPath: string;
  logicalPath?: string;
}

function failure(
  sourceCli: SourceCli,
  code: NativeCaptureErrorCode,
  message: string,
): NativeCaptureFailure {
  return {
    ok: false,
    error: {
      schemaVersion: '1.0.0',
      sourceCli,
      code,
      message,
    },
  };
}

/**
 * Strict read-only JSONL capture shared by source adapters.
 *
 * Unlike normalized preview readers, this function never skips a malformed
 * line and never returns the valid prefix of a failed transcript. Every
 * nonblank line must be a JSON object. Failure values contain only a stable
 * source/category/message tuple: never source bytes or an absolute path.
 */
export function captureStrictJsonl(
  options: StrictJsonlCaptureOptions,
): NativeArtifactCaptureResult {
  const {
    sourceCli,
    sourceFormat,
    sessionIdAlias,
    transcriptPath,
    logicalPath = 'native/session.jsonl',
  } = options;

  if (transcriptPath.endsWith('.jsonl.zst') || transcriptPath.endsWith('.zst')) {
    return failure(
      sourceCli,
      'unsupported-compression',
      'Compressed native sessions are unsupported in ReplayBundle v1.',
    );
  }
  if (!transcriptPath.endsWith('.jsonl')) {
    return failure(
      sourceCli,
      'unsupported-format',
      'The native session format is unsupported in ReplayBundle v1.',
    );
  }

  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch (error) {
    const code = fs.existsSync(transcriptPath)
      ? 'unreadable-file'
      : 'missing-file';
    return failure(
      sourceCli,
      code,
      'The native session could not be read.',
    );
  }

  const nonblankLines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (nonblankLines.length === 0) {
    return failure(
      sourceCli,
      'empty-session',
      'The native session contains no JSONL rows.',
    );
  }

  const rows: NativeSessionArtifact['files'][number]['rows'] = [];
  for (const [ordinal, line] of nonblankLines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return failure(
        sourceCli,
        'malformed-jsonl',
        'The native session contains malformed JSONL.',
      );
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return failure(
        sourceCli,
        'non-object-row',
        'Every native JSONL row must be a JSON object.',
      );
    }
    rows.push({
      ordinal,
      value: value as NativeSessionArtifact['files'][number]['rows'][number]['value'],
    });
  }

  const artifact = NativeSessionArtifactSchema.parse({
    schemaVersion: '1.0.0',
    sourceCli,
    sourceFormat,
    sessionIdAlias,
    files: [
      {
        id: 'transcript',
        role: 'primary',
        logicalPath,
        rows,
      },
    ],
  });
  return { ok: true, artifact };
}

/** Safe conservative defaults, enriched by each source-specific adapter. */
export function baseSourceSummary(
  artifact: NativeSessionArtifact,
): SafeSourceSummary {
  return {
    schemaVersion: '1.0.0',
    sourceCli: artifact.sourceCli,
    sourceFormat: artifact.sourceFormat,
    sessionIdAlias: artifact.sessionIdAlias,
    recordedCliVersion: null,
    modelProvider: null,
    sourceModels: [],
    modelTimeline: [],
    contextWindow: null,
    sessionMode: 'unknown',
    entrypoint: 'unknown',
  };
}

/** Safe conservative counts, enriched by each source-specific adapter. */
export function baseTrajectory(
  artifact: NativeSessionArtifact,
): ReplayTrajectory {
  return {
    schemaVersion: '1.0.0',
    totalRows: artifact.files.reduce((sum, file) => sum + file.rows.length, 0),
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolResults: 0,
    compactedEvents: 0,
  };
}

export function completeNativeCapture(
  captured: NativeArtifactCaptureResult,
  source?: SafeSourceSummary,
  trajectory?: ReplayTrajectory,
): NativeCaptureResult {
  if (!captured.ok) return captured;
  return {
    ok: true,
    artifact: captured.artifact,
    source: source ?? baseSourceSummary(captured.artifact),
    trajectory: trajectory ?? baseTrajectory(captured.artifact),
  };
}

type UnknownObject = Record<string, unknown>;

function asObject(value: unknown): UnknownObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownObject)
    : undefined;
}

function firstString(
  object: UnknownObject,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function firstPositiveInteger(
  object: UnknownObject,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function safeEntrypoint(value: string | null): SafeSourceSummary['entrypoint'] {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase();
  if (['terminal', 'cli', 'command-line'].includes(normalized)) return 'terminal';
  if (
    ['ide', 'vscode', 'jetbrains', 'visual-studio-code'].includes(normalized)
  ) {
    return 'ide';
  }
  if (['api', 'sdk'].includes(normalized)) return 'api';
  return 'unknown';
}

function safeSessionMode(
  value: string | null,
): SafeSourceSummary['sessionMode'] {
  if (!value) return 'unknown';
  const normalized = value.toLowerCase();
  if (['interactive', 'default'].includes(normalized)) return 'interactive';
  if (
    ['non-interactive', 'headless', 'print', 'batch'].includes(normalized)
  ) {
    return 'non-interactive';
  }
  return 'unknown';
}

function countClaudeBlocks(
  content: unknown,
): Pick<ReplayTrajectory, 'toolCalls' | 'toolResults'> {
  let toolCalls = 0;
  let toolResults = 0;
  if (!Array.isArray(content)) return { toolCalls, toolResults };
  for (const item of content) {
    const block = asObject(item);
    if (!block) continue;
    if (block.type === 'tool_use') toolCalls += 1;
    if (block.type === 'tool_result') toolResults += 1;
  }
  return { toolCalls, toolResults };
}

/**
 * Derive only the low-risk Claude source summary and aggregate trajectory.
 * Every row remains in the native artifact; identity fields such as cwd, git
 * data, title, and raw instructions are deliberately not projected here.
 */
export function extractClaudeNativeContext(
  artifact: NativeSessionArtifact,
): { source: SafeSourceSummary; trajectory: ReplayTrajectory } {
  const source = baseSourceSummary(artifact);
  const trajectory = baseTrajectory(artifact);
  const models: string[] = [];
  let assistantTurnIndex = 0;

  for (const file of artifact.files) {
    for (const row of file.rows) {
      const value = row.value as UnknownObject;
      const message = asObject(value.message);

      source.recordedCliVersion ??= firstString(value, [
        'cliVersion',
        'cli_version',
        'version',
      ]);
      source.modelProvider ??=
        firstString(value, ['modelProvider', 'model_provider']) ??
        (message
          ? firstString(message, ['modelProvider', 'model_provider'])
          : null);
      source.contextWindow ??=
        firstPositiveInteger(value, ['contextWindow', 'context_window']) ??
        (message
          ? firstPositiveInteger(message, ['contextWindow', 'context_window'])
          : null);
      if (source.entrypoint === 'unknown') {
        source.entrypoint = safeEntrypoint(
          firstString(value, ['entrypoint', 'entryPoint']),
        );
      }
      if (source.sessionMode === 'unknown') {
        source.sessionMode = safeSessionMode(
          firstString(value, ['mode', 'sessionMode']),
        );
      }

      const role =
        (message && typeof message.role === 'string' && message.role) ||
        (typeof value.role === 'string' ? value.role : null);
      if (role === 'user') trajectory.userTurns += 1;
      if (role === 'assistant') {
        trajectory.assistantTurns += 1;
        const model =
          (message &&
            firstString(message, ['model', 'modelName', 'model_name'])) ||
          firstString(value, ['model', 'modelName', 'model_name']);
        const effort =
          (message &&
            firstString(message, [
              'effort',
              'reasoningEffort',
              'reasoning_effort',
            ])) ||
          firstString(value, [
            'effort',
            'reasoningEffort',
            'reasoning_effort',
          ]);
        if (model) {
          if (!models.includes(model)) models.push(model);
          source.modelTimeline.push({
            assistantTurnIndex,
            model,
            effort,
          });
        }
        assistantTurnIndex += 1;
      }

      const counts = countClaudeBlocks(message?.content);
      trajectory.toolCalls += counts.toolCalls;
      trajectory.toolResults += counts.toolResults;
      if (
        value.isCompactSummary === true ||
        value.type === 'summary' ||
        value.type === 'compact' ||
        value.type === 'compacted'
      ) {
        trajectory.compactedEvents += 1;
      }
    }
  }

  source.sourceModels = models;
  return { source, trajectory };
}

/**
 * Derive low-risk Codex context from retained session_meta/turn_context rows.
 * response_item is the trajectory source of truth; event_msg mirrors are
 * preserved in the artifact but intentionally do not double-count turns.
 */
export function extractCodexNativeContext(
  artifact: NativeSessionArtifact,
): { source: SafeSourceSummary; trajectory: ReplayTrajectory } {
  const source = baseSourceSummary(artifact);
  const trajectory = baseTrajectory(artifact);
  const models: string[] = [];
  let assistantTurnIndex = 0;
  let currentModel: string | null = null;
  let currentEffort: string | null = null;

  for (const file of artifact.files) {
    for (const row of file.rows) {
      const value = row.value as UnknownObject;
      const payload = asObject(value.payload) ?? {};

      if (value.type === 'session_meta') {
        source.recordedCliVersion ??= firstString(payload, [
          'cliVersion',
          'cli_version',
          'version',
        ]);
        source.modelProvider ??= firstString(payload, [
          'modelProvider',
          'model_provider',
        ]);
        source.contextWindow ??= firstPositiveInteger(payload, [
          'contextWindow',
          'context_window',
          'modelContextWindow',
          'model_context_window',
        ]);
        if (source.entrypoint === 'unknown') {
          source.entrypoint = safeEntrypoint(
            firstString(payload, ['entrypoint', 'originator']),
          );
        }
        if (source.sessionMode === 'unknown') {
          source.sessionMode = safeSessionMode(
            firstString(payload, ['mode', 'sessionMode', 'session_mode']),
          );
        }
        continue;
      }

      if (value.type === 'turn_context') {
        currentModel =
          firstString(payload, ['model', 'modelName', 'model_name']) ??
          currentModel;
        currentEffort =
          firstString(payload, [
            'effort',
            'reasoningEffort',
            'reasoning_effort',
          ]) ?? null;
        source.modelProvider ??= firstString(payload, [
          'modelProvider',
          'model_provider',
        ]);
        source.contextWindow ??= firstPositiveInteger(payload, [
          'contextWindow',
          'context_window',
          'modelContextWindow',
          'model_context_window',
        ]);
        if (source.entrypoint === 'unknown') {
          source.entrypoint = safeEntrypoint(
            firstString(payload, ['entrypoint', 'originator']),
          );
        }
        if (source.sessionMode === 'unknown') {
          source.sessionMode = safeSessionMode(
            firstString(payload, ['mode', 'sessionMode', 'session_mode']),
          );
        }
        continue;
      }

      if (value.type === 'compacted') {
        trajectory.compactedEvents += 1;
        continue;
      }
      if (value.type !== 'response_item') continue;

      const itemType =
        typeof payload.type === 'string' ? payload.type : undefined;
      if (itemType === 'message') {
        if (payload.role === 'user') trajectory.userTurns += 1;
        if (payload.role === 'assistant') {
          trajectory.assistantTurns += 1;
          const model =
            firstString(payload, ['model', 'modelName', 'model_name']) ??
            currentModel;
          const effort =
            firstString(payload, [
              'effort',
              'reasoningEffort',
              'reasoning_effort',
            ]) ?? currentEffort;
          if (model) {
            if (!models.includes(model)) models.push(model);
            source.modelTimeline.push({
              assistantTurnIndex,
              model,
              effort,
            });
          }
          assistantTurnIndex += 1;
        }
      } else if (
        itemType === 'function_call' ||
        itemType === 'custom_tool_call' ||
        itemType === 'computer_call'
      ) {
        trajectory.toolCalls += 1;
      } else if (
        itemType === 'function_call_output' ||
        itemType === 'custom_tool_call_output' ||
        itemType === 'computer_call_output'
      ) {
        trajectory.toolResults += 1;
      }
    }
  }

  source.sourceModels = models;
  return { source, trajectory };
}
