import { createHash } from 'node:crypto';

import { ReplayBundleDraftSchema } from '@mosga/contracts';
import type {
  InstructionSnapshotFile,
  JsonValue,
  NativeJsonlFile,
  NativeJsonlRow,
  ReplayBundleDraft,
  ReplayFinding,
  ReplayFindingLocation,
  ReplayOpaqueItem,
  ReplaySpan,
} from '@mosga/contracts';

import { PseudonymMapper } from './pseudonym.js';
import { canonicalJson } from './canonical.js';
import {
  REPLAY_REPORT_VERSION,
  ReplaySanitizationReportSchema,
  type CompiledRuleset,
  type ReplaySanitizationGate,
  type ReplaySanitizationReport,
  type ReplayScanFailure,
} from './schemas.js';
import {
  scanDetectorUnits,
  type DetectorScanUnit,
  type RulesetWarning,
} from './scan.js';

type WithoutSpan<Location> = Location extends unknown
  ? Omit<Location, 'span'>
  : never;
type ReplayLocationWithoutSpan = WithoutSpan<ReplayFindingLocation>;

interface ReplayCoordinateIndex {
  nativeFiles: Map<string, NativeJsonlFile>;
  nativeRows: Map<string, Map<number, NativeJsonlRow>>;
  instructions: Map<string, InstructionSnapshotFile>;
}

/**
 * Build an unambiguous coordinate index. Returning undefined on any duplicate
 * keeps direct resolver callers fail-closed even if they bypass schema parsing.
 */
function buildReplayCoordinateIndex(
  draft: ReplayBundleDraft,
): ReplayCoordinateIndex | undefined {
  const nativeFiles = new Map<string, NativeJsonlFile>();
  const nativeRows = new Map<string, Map<number, NativeJsonlRow>>();
  for (const file of draft.nativeSession.files) {
    if (nativeFiles.has(file.id)) return undefined;
    nativeFiles.set(file.id, file);
    const rows = new Map<number, NativeJsonlRow>();
    for (const row of file.rows) {
      if (rows.has(row.ordinal)) return undefined;
      rows.set(row.ordinal, row);
    }
    nativeRows.set(file.id, rows);
  }

  const instructions = new Map<string, InstructionSnapshotFile>();
  for (const instruction of draft.instructionSnapshot.files) {
    if (instructions.has(instruction.id)) return undefined;
    instructions.set(instruction.id, instruction);
  }
  return { nativeFiles, nativeRows, instructions };
}

export function resolveReplayNativeRow(
  draft: ReplayBundleDraft,
  fileId: string,
  rowOrdinal: number,
): NativeJsonlRow | undefined {
  return buildReplayCoordinateIndex(draft)?.nativeRows
    .get(fileId)
    ?.get(rowOrdinal);
}

export function resolveReplayInstruction(
  draft: ReplayBundleDraft,
  instructionId: string,
): InstructionSnapshotFile | undefined {
  return buildReplayCoordinateIndex(draft)?.instructions.get(instructionId);
}

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointerToken(token: string): string | undefined {
  if (/~(?:[^01]|$)/.test(token)) return undefined;
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function pointerChild(pointer: string, token: string): string {
  return `${pointer}/${escapePointerToken(token)}`;
}

/**
 * Visit every JSON string leaf. Object keys are sorted so scan order and
 * replay-wide pseudonym numbering do not depend on source object member order;
 * arrays preserve their semantic order.
 */
export function collectJsonStringLeaves(
  value: JsonValue,
  pointer = '',
): Array<{ pointer: string; text: string }> {
  if (typeof value === 'string') return [{ pointer, text: value }];
  if (value === null || typeof value !== 'object') return [];
  const leaves: Array<{ pointer: string; text: string }> = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      leaves.push(
        ...collectJsonStringLeaves(item, pointerChild(pointer, String(index))),
      );
    });
    return leaves;
  }
  for (const key of Object.keys(value).sort()) {
    leaves.push(
      ...collectJsonStringLeaves(value[key]!, pointerChild(pointer, key)),
    );
  }
  return leaves;
}

/** Resolve an RFC 6901 pointer without coercing or reparsing a string leaf. */
export function resolveJsonPointer(
  root: unknown,
  pointer: string,
): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = unescapePointerToken(rawToken);
    if (token === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function locatedUnit(
  text: string,
  locationWithoutSpan: ReplayLocationWithoutSpan,
): DetectorScanUnit<ReplayFindingLocation> {
  return {
    text,
    location: (span: ReplaySpan) => ({
      ...locationWithoutSpan,
      span,
    }) as ReplayFindingLocation,
  };
}

function collectMetadataSubtree(
  draft: ReplayBundleDraft,
  fieldPath: string,
): DetectorScanUnit<ReplayFindingLocation>[] {
  const value = resolveJsonPointer(draft, fieldPath) as JsonValue | undefined;
  if (value === undefined) return [];
  return collectJsonStringLeaves(value, fieldPath).map(({ pointer, text }) =>
    locatedUnit(text, { kind: 'metadata', fieldPath: pointer }),
  );
}

/**
 * Build the complete deterministic replay scan coordinate space:
 * native JSON string leaves, instruction contents, and fixed metadata.
 */
export function collectReplayScanUnits(
  draft: ReplayBundleDraft,
): DetectorScanUnit<ReplayFindingLocation>[] {
  const units: DetectorScanUnit<ReplayFindingLocation>[] = [];

  for (const file of draft.nativeSession.files) {
    for (const row of file.rows) {
      for (const leaf of collectJsonStringLeaves(row.value)) {
        units.push(
          locatedUnit(leaf.text, {
            kind: 'native',
            fileId: file.id,
            rowOrdinal: row.ordinal,
            jsonPointer: leaf.pointer,
          }),
        );
      }
    }
  }

  for (const instruction of draft.instructionSnapshot.files) {
    units.push(
      locatedUnit(instruction.content, {
        kind: 'instruction',
        instructionId: instruction.id,
      }),
    );
  }

  const metadataRoots = [
    '/source',
    '/nativeSession/sessionIdAlias',
    '/terminalManifestSeed',
    '/runtimePolicy/projectAlias',
    '/runtimePolicy/workingDirectoryAlias',
    '/delivery',
    '/omissions',
  ];
  for (const root of metadataRoots) {
    units.push(...collectMetadataSubtree(draft, root));
  }

  for (const [index, file] of draft.nativeSession.files.entries()) {
    for (const field of ['id', 'logicalPath'] as const) {
      units.push(
        locatedUnit(file[field], {
          kind: 'metadata',
          fieldPath: `/nativeSession/files/${index}/${field}`,
        }),
      );
    }
  }
  for (const [index, file] of draft.instructionSnapshot.files.entries()) {
    for (const field of ['id', 'stagePath'] as const) {
      units.push(
        locatedUnit(file[field], {
          kind: 'metadata',
          fieldPath: `/instructionSnapshot/files/${index}/${field}`,
        }),
      );
    }
  }

  return units;
}

/** Resolve the complete original string addressed by a replay location. */
export function resolveReplayLocationText(
  draft: ReplayBundleDraft,
  location: ReplayFindingLocation,
): string | undefined {
  if (location.kind === 'native') {
    const row = resolveReplayNativeRow(
      draft,
      location.fileId,
      location.rowOrdinal,
    );
    const value = row
      ? resolveJsonPointer(row.value, location.jsonPointer)
      : undefined;
    return typeof value === 'string' ? value : undefined;
  }
  if (location.kind === 'instruction') {
    return resolveReplayInstruction(draft, location.instructionId)?.content;
  }
  const value = resolveJsonPointer(draft, location.fieldPath);
  return typeof value === 'string' ? value : undefined;
}

/** Resolve the exact span, refusing stale/out-of-range locations. */
export function resolveReplayLocationSpan(
  draft: ReplayBundleDraft,
  location: ReplayFindingLocation,
): string | undefined {
  const text = resolveReplayLocationText(draft, location);
  if (
    text === undefined ||
    location.span.start > location.span.end ||
    location.span.end > text.length
  ) {
    return undefined;
  }
  return text.slice(location.span.start, location.span.end);
}

export function replayFindingId(
  location: ReplayFindingLocation,
  ruleId: string,
): string {
  let coordinate: Array<string | number>;
  if (location.kind === 'native') {
    coordinate = [
      location.kind,
      location.fileId,
      location.rowOrdinal,
      location.jsonPointer,
      location.span.start,
      location.span.end,
    ];
  } else if (location.kind === 'instruction') {
    coordinate = [
      location.kind,
      location.instructionId,
      location.span.start,
      location.span.end,
    ];
  } else {
    coordinate = [
      location.kind,
      location.fieldPath,
      location.span.start,
      location.span.end,
    ];
  }
  return createHash('sha256')
    .update(JSON.stringify([...coordinate, ruleId]))
    .digest('hex')
    .slice(0, 16);
}

export function computeReplayGate(
  findings: ReplayFinding[],
  opaqueItems: ReplayOpaqueItem[],
): ReplaySanitizationGate {
  const blocking = findings.filter((finding) => finding.blocking);
  const blockingPending = blocking.filter(
    (finding) => finding.disposition === 'pending',
  ).length;
  const opaquePending = opaqueItems.filter(
    (item) => item.disposition === 'pending',
  ).length;
  return {
    schemaVersion: REPLAY_REPORT_VERSION,
    blockingTotal: blocking.length,
    blockingPending,
    opaquePending,
    unlocked: blockingPending === 0 && opaquePending === 0,
  };
}

const OPAQUE_BLOCK_TYPES = new Set([
  'image',
  'input_image',
  'output_image',
  'audio',
  'input_audio',
  'output_audio',
  'binary',
  'file',
  'file_attachment',
  'computer_screenshot',
]);

export function replayOpaqueItemId(
  fileId: string,
  rowOrdinal: number,
  jsonPointer: string,
  blockType: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'opaque',
        fileId,
        rowOrdinal,
        jsonPointer,
        blockType,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

function collectOpaqueValues(
  value: JsonValue,
  pointer: string,
  fileId: string,
  rowOrdinal: number,
  out: ReplayOpaqueItem[],
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectOpaqueValues(
        item,
        pointerChild(pointer, String(index)),
        fileId,
        rowOrdinal,
        out,
      ),
    );
    return;
  }

  const blockType =
    typeof value.type === 'string' ? value.type : undefined;
  if (blockType && OPAQUE_BLOCK_TYPES.has(blockType)) {
    out.push({
      id: replayOpaqueItemId(fileId, rowOrdinal, pointer, blockType),
      location: {
        kind: 'native',
        fileId,
        rowOrdinal,
        jsonPointer: pointer,
      },
      blockType,
      matchPreview: `[opaque:${blockType}]`,
      disposition: 'pending',
      replacement: null,
    });
  }

  for (const key of Object.keys(value).sort()) {
    collectOpaqueValues(
      value[key]!,
      pointerChild(pointer, key),
      fileId,
      rowOrdinal,
      out,
    );
  }
}

/** Find source-recognized opaque/non-text native blocks without modifying them. */
export function collectReplayOpaqueItems(
  draft: ReplayBundleDraft,
): ReplayOpaqueItem[] {
  const items: ReplayOpaqueItem[] = [];
  for (const file of draft.nativeSession.files) {
    for (const row of file.rows) {
      collectOpaqueValues(
        row.value,
        '',
        file.id,
        row.ordinal,
        items,
      );
    }
  }
  return items;
}

export interface ReplayScanOptions {
  generatedAt?: string;
}

export interface ReplayScanExecutionSuccess {
  ok: true;
  report: ReplaySanitizationReport;
  mapper: PseudonymMapper;
  rulesetWarnings: RulesetWarning[];
}

export type ReplayScanResult = ReplayScanExecutionSuccess | ReplayScanFailure;

/** Hash the complete schema-valid replay draft using the report identity format. */
export function hashReplayDraftContent(draft: ReplayBundleDraft): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(draft))
    .digest('hex')}`;
}

function assembleReplayReport(
  draft: ReplayBundleDraft,
  ruleset: CompiledRuleset,
  findings: ReplayFinding[],
  opaqueItems: ReplayOpaqueItem[],
  generatedAt: string | undefined,
): ReplaySanitizationReport {
  const secrets = findings.filter((finding) => finding.layer === 'secrets');
  const custom = findings.filter((finding) => finding.layer === 'custom');
  const normalization = findings.filter(
    (finding) => finding.layer === 'normalization',
  );
  const guard = findings.filter((finding) => finding.layer === 'guard');
  const byCategory: Record<string, number> = {};
  for (const finding of normalization) {
    const key = finding.category ?? 'other';
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }

  return ReplaySanitizationReportSchema.parse({
    schemaVersion: REPLAY_REPORT_VERSION,
    reportVersion: REPLAY_REPORT_VERSION,
    draftId: draft.draftId,
    draftContentHash: hashReplayDraftContent(draft),
    sanitizationRulesetVersion: ruleset.rulesetVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
    findings,
    opaqueItems,
    layerSummary: {
      secrets: {
        total: secrets.length,
        pending: secrets.filter(
          (finding) => finding.disposition === 'pending',
        ).length,
      },
      custom: {
        total: custom.length,
        pending: custom.filter(
          (finding) => finding.disposition === 'pending',
        ).length,
      },
      normalization: {
        total: normalization.length,
        byCategory,
      },
      guard: {
        total: guard.length,
        pending: guard.filter(
          (finding) => finding.disposition === 'pending',
        ).length,
      },
    },
    gate: computeReplayGate(findings, opaqueItems),
  });
}

/**
 * Scan a complete ReplayBundle draft under one detector execution and one
 * replay-scoped PseudonymMapper.
 */
export function scanReplayDraft(
  input: ReplayBundleDraft,
  ruleset: CompiledRuleset,
  options: ReplayScanOptions = {},
): ReplayScanResult {
  const parsed = ReplayBundleDraftSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        schemaVersion: REPLAY_REPORT_VERSION,
        code: 'invalid-draft',
        message: 'The ReplayBundle draft is invalid.',
      },
    };
  }

  try {
    const draft = parsed.data;
    const mapper = new PseudonymMapper();
    const scan = scanDetectorUnits(
      collectReplayScanUnits(draft),
      ruleset,
      mapper,
      {
        findingId: replayFindingId,
        warningLocation: () => ({
          kind: 'metadata' as const,
          fieldPath:
            '/terminalManifestSeed/sanitization/rulesetVersion',
          span: { start: 0, end: 0 },
        }),
        guardLayer: 'guard',
      },
    );
    const findings: ReplayFinding[] = scan.findings.map((finding) => {
      const matched =
        resolveReplayLocationSpan(draft, finding.location) ?? '';
      return {
        ...finding,
        category: finding.category ?? null,
        matchPreview:
          finding.layer === 'normalization'
            ? `[redacted:normalization:${finding.ruleId}]`
            : finding.matchPreview,
        matchHash: `sha256:${createHash('sha256')
          .update(matched)
          .digest('hex')}`,
      };
    });
    const opaqueItems = collectReplayOpaqueItems(draft);
    const report = assembleReplayReport(
      draft,
      ruleset,
      findings,
      opaqueItems,
      options.generatedAt,
    );
    return {
      ok: true,
      report,
      mapper,
      rulesetWarnings: scan.rulesetWarnings,
    };
  } catch {
    return {
      ok: false,
      error: {
        schemaVersion: REPLAY_REPORT_VERSION,
        code: 'scan-failed',
        message: 'ReplayBundle scanning failed.',
      },
    };
  }
}
