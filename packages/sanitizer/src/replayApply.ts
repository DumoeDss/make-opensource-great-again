import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  canonicalizeReplayReviewedDraft,
  ReplayBundleDraftSchema,
  ReplayBundlePayloadSchema,
  type JsonValue,
  type ReplayBundleDraft,
  type ReplayBundlePayload,
  type ReplayFinding,
  type ReplayFindingLocation,
  type ReplayOpaqueItem,
} from '@mosga/contracts';

import { PseudonymMapper } from './pseudonym.js';
import {
  computeReplayGate,
  hashReplayDraftContent,
  replayFindingId,
  replayOpaqueItemId,
  resolveJsonPointer,
  resolveReplayInstruction,
  resolveReplayLocationText,
  resolveReplayLocationSpan,
  resolveReplayNativeRow,
  scanReplayDraft,
} from './replayScan.js';
import {
  ReplaySanitizationReportSchema,
  type CompiledRuleset,
  type NormalizationCategory,
  type ReplaySanitizationGate,
  type ReplaySanitizationReport,
} from './schemas.js';

export type ReplayApplyErrorCode =
  | 'invalid-draft'
  | 'invalid-report'
  | 'draft-id-mismatch'
  | 'draft-content-mismatch'
  | 'ruleset-mismatch'
  | 'mapper-mismatch'
  | 'missing-location'
  | 'out-of-range-location'
  | 'stale-location'
  | 'invalid-finding'
  | 'invalid-opaque-item'
  | 'missing-opaque-location'
  | 'missing-opaque-replacement'
  | 'write-failed'
  | 'invalid-reviewed-output'
  | 'post-apply-scan-failed'
  | 'surviving-blocking-canary';

export interface ReplayApplyError {
  schemaVersion: '1.0.0';
  code: ReplayApplyErrorCode;
  message: string;
  findingId: string | null;
}

export type ReplayEditResult =
  | { ok: true; draft: ReplayBundleDraft }
  | { ok: false; error: ReplayApplyError };

export type ReplayOpaqueEditResult =
  | {
      ok: true;
      draft: ReplayBundleDraft;
      pendingOpaqueItems: number;
    }
  | { ok: false; error: ReplayApplyError };

export interface ReplayApplyOptions {
  /** The exact compiled ruleset used for both the original and verification scans. */
  ruleset: CompiledRuleset;
  /** Caller-held identity; never inferred solely from the mutable report. */
  expectedRulesetVersion: string;
  decisionVersion: string;
  approvedAt?: string;
}

export type ReplayDispositionApplyResult =
  | {
      ok: true;
      /** Immutable preview, including resolved edits even while the gate is locked. */
      draft: ReplayBundleDraft;
      gate: ReplaySanitizationGate;
      /** Present only after an unlocked, schema-valid, verified review. */
      sealablePayload: ReplayBundlePayload | null;
    }
  | { ok: false; error: ReplayApplyError };

export function hashReplayMatch(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function cloneReplayDraft(
  draft: ReplayBundleDraft,
): ReplayEditResult {
  const parsed = ReplayBundleDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        schemaVersion: '1.0.0',
        code: 'invalid-draft',
        message: 'The ReplayBundle draft is invalid.',
        findingId: null,
      },
    };
  }
  return { ok: true, draft: structuredClone(parsed.data) };
}

function unescapePointerToken(token: string): string | undefined {
  if (/~(?:[^01]|$)/.test(token)) return undefined;
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function parseJsonPointerTokens(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const tokens: string[] = [];
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = unescapePointerToken(rawToken);
    if (token === undefined) return undefined;
    tokens.push(token);
  }
  return tokens;
}

function jsonPointerFromTokens(tokens: string[]): string {
  return tokens.length === 0
    ? ''
    : `/${tokens.map(escapePointerToken).join('/')}`;
}

function writeJsonPointerString(
  root: unknown,
  pointer: string,
  value: string,
): boolean {
  if (!pointer.startsWith('/') || pointer === '') return false;
  const rawTokens = pointer.slice(1).split('/');
  const finalRaw = rawTokens.pop();
  if (finalRaw === undefined) return false;
  let parent: unknown = root;
  for (const rawToken of rawTokens) {
    const token = unescapePointerToken(rawToken);
    if (token === undefined) return false;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false;
      parent = parent[Number(token)];
    } else if (parent !== null && typeof parent === 'object') {
      if (!Object.prototype.hasOwnProperty.call(parent, token)) return false;
      parent = (parent as Record<string, unknown>)[token];
    } else {
      return false;
    }
  }
  const finalToken = unescapePointerToken(finalRaw);
  if (finalToken === undefined) return false;
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(finalToken)) return false;
    const index = Number(finalToken);
    if (index >= parent.length || typeof parent[index] !== 'string') {
      return false;
    }
    parent[index] = value;
    return true;
  }
  if (parent === null || typeof parent !== 'object') return false;
  if (
    !Object.prototype.hasOwnProperty.call(parent, finalToken) ||
    typeof (parent as Record<string, unknown>)[finalToken] !== 'string'
  ) {
    return false;
  }
  (parent as Record<string, unknown>)[finalToken] = value;
  return true;
}

/** Write one exact string leaf in a mutable cloned draft. */
export function writeReplayLocationText(
  draft: ReplayBundleDraft,
  location: ReplayFindingLocation,
  value: string,
): boolean {
  if (location.kind === 'native') {
    const row = resolveReplayNativeRow(
      draft,
      location.fileId,
      location.rowOrdinal,
    );
    return row
      ? writeJsonPointerString(row.value, location.jsonPointer, value)
      : false;
  }
  if (location.kind === 'instruction') {
    const instruction = resolveReplayInstruction(
      draft,
      location.instructionId,
    );
    if (!instruction) return false;
    instruction.content = value;
    return true;
  }
  return writeJsonPointerString(draft, location.fieldPath, value);
}

function locationKey(location: ReplayFindingLocation): string {
  if (location.kind === 'native') {
    return JSON.stringify([
      location.kind,
      location.fileId,
      location.rowOrdinal,
      location.jsonPointer,
    ]);
  }
  if (location.kind === 'instruction') {
    return JSON.stringify([location.kind, location.instructionId]);
  }
  return JSON.stringify([location.kind, location.fieldPath]);
}

function failure(
  code: ReplayApplyErrorCode,
  message: string,
  findingId: string | null,
): ReplayEditResult {
  return {
    ok: false,
    error: {
      schemaVersion: '1.0.0',
      code,
      message,
      findingId,
    },
  };
}

interface ReplayStringEdit {
  start: number;
  end: number;
  text: string;
}

function selectReplayStringEdits(
  findings: ReplayFinding[],
): ReplayStringEdit[] {
  const edits = findings
    .filter(
      (finding) =>
        finding.disposition === 'replace' ||
        finding.disposition === 'delete',
    )
    .map((finding) => ({
      start: finding.location.span.start,
      end: finding.location.span.end,
      text:
        finding.disposition === 'replace'
          ? finding.replacementSuggestion
          : '',
    }))
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const selected: ReplayStringEdit[] = [];
  let coveredEnd = -1;
  for (const edit of edits) {
    if (edit.start >= coveredEnd) {
      selected.push(edit);
      coveredEnd = Math.max(coveredEnd, edit.end);
    }
  }
  return selected;
}

function editString(original: string, findings: ReplayFinding[]): string {
  const selected = selectReplayStringEdits(findings).sort(
    (left, right) => right.start - left.start,
  );
  let output = original;
  for (const edit of selected) {
    output =
      output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

/**
 * Validate all report coordinates against the unchanged original, then apply
 * offset-safe edits to an immutable clone.
 */
export function applyReplayFindingEdits(
  draft: ReplayBundleDraft,
  findings: ReplayFinding[],
): ReplayEditResult {
  const cloned = cloneReplayDraft(draft);
  if (!cloned.ok) return cloned;

  const groups = new Map<string, ReplayFinding[]>();
  for (const finding of findings) {
    if (replayFindingId(finding.location, finding.ruleId) !== finding.id) {
      return failure(
        'invalid-finding',
        'A replay finding id does not match its location and rule.',
        finding.id,
      );
    }
    const original = resolveReplayLocationText(draft, finding.location);
    if (original === undefined) {
      return failure(
        'missing-location',
        'A reviewed replay location no longer exists.',
        finding.id,
      );
    }
    const { start, end } = finding.location.span;
    if (start > end || end > original.length) {
      return failure(
        'out-of-range-location',
        'A reviewed replay span is outside its string value.',
        finding.id,
      );
    }
    if (hashReplayMatch(original.slice(start, end)) !== finding.matchHash) {
      return failure(
        'stale-location',
        'A reviewed replay span no longer contains the scanned value.',
        finding.id,
      );
    }
    const key = locationKey(finding.location);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  for (const group of groups.values()) {
    const location = group[0]!.location;
    const original = resolveReplayLocationText(draft, location);
    if (original === undefined) {
      return failure(
        'missing-location',
        'A reviewed replay location no longer exists.',
        group[0]!.id,
      );
    }
    const edited = editString(original, group);
    if (
      edited !== original &&
      !writeReplayLocationText(cloned.draft, location, edited)
    ) {
      return failure(
        'write-failed',
        'A reviewed replay edit could not be written.',
        group[0]!.id,
      );
    }
  }

  return cloned;
}

function mutateJsonPointer(
  root: unknown,
  pointer: string,
  action: 'remove' | 'replace',
  replacement: JsonValue | null,
): boolean {
  if (!pointer.startsWith('/') || pointer === '') return false;
  const rawTokens = pointer.slice(1).split('/');
  const finalRaw = rawTokens.pop();
  if (finalRaw === undefined) return false;
  let parent: unknown = root;
  for (const rawToken of rawTokens) {
    const token = unescapePointerToken(rawToken);
    if (token === undefined) return false;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return false;
      const index = Number(token);
      if (index >= parent.length) return false;
      parent = parent[index];
    } else if (parent !== null && typeof parent === 'object') {
      if (!Object.prototype.hasOwnProperty.call(parent, token)) return false;
      parent = (parent as Record<string, unknown>)[token];
    } else {
      return false;
    }
  }
  const finalToken = unescapePointerToken(finalRaw);
  if (finalToken === undefined) return false;

  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(finalToken)) return false;
    const index = Number(finalToken);
    if (index >= parent.length) return false;
    if (action === 'remove') parent.splice(index, 1);
    else parent[index] = structuredClone(replacement);
    return true;
  }
  if (parent === null || typeof parent !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(parent, finalToken)) return false;
  if (action === 'remove') {
    delete (parent as Record<string, unknown>)[finalToken];
  } else {
    (parent as Record<string, unknown>)[finalToken] =
      structuredClone(replacement);
  }
  return true;
}

function opaquePointerDepth(pointer: string): number {
  return pointer === '' ? 0 : pointer.slice(1).split('/').length;
}

function opaqueMutationOrder(
  left: ReplayOpaqueItem,
  right: ReplayOpaqueItem,
): number {
  const depthDifference =
    opaquePointerDepth(right.location.jsonPointer) -
    opaquePointerDepth(left.location.jsonPointer);
  if (depthDifference !== 0) return depthDifference;

  const leftTokens = left.location.jsonPointer.split('/');
  const rightTokens = right.location.jsonPointer.split('/');
  const leftFinal = leftTokens.pop() ?? '';
  const rightFinal = rightTokens.pop() ?? '';
  if (
    leftTokens.join('/') === rightTokens.join('/') &&
    /^(0|[1-9]\d*)$/.test(leftFinal) &&
    /^(0|[1-9]\d*)$/.test(rightFinal)
  ) {
    return Number(rightFinal) - Number(leftFinal);
  }
  return left.location.jsonPointer < right.location.jsonPointer
    ? 1
    : left.location.jsonPointer > right.location.jsonPointer
      ? -1
      : 0;
}

/**
 * Apply only explicit source-aware opaque decisions. Pending and keep preserve
 * the original block; remove/replace target the exact block and append a safe
 * reviewed omission without copying opaque bytes.
 *
 * Every item is resolved against the unchanged original before any mutation.
 * Mutations then run deepest-first; array siblings sharing a parent run at
 * descending indices. Thus an ancestor decision deterministically wins after
 * any reviewed descendant decisions without invalidating their coordinates.
 */
function applyReplayOpaqueDecisionsAgainstOriginal(
  draft: ReplayBundleDraft,
  opaqueItems: ReplayOpaqueItem[],
  originalDraft: ReplayBundleDraft,
): ReplayOpaqueEditResult {
  const cloned = cloneReplayDraft(draft);
  if (!cloned.ok) return cloned;
  if (!ReplayBundleDraftSchema.safeParse(originalDraft).success) {
    return {
      ok: false,
      error: makeReplayApplyError(
        'invalid-draft',
        'The original ReplayBundle draft is invalid.',
      ),
    };
  }
  const seenItemIds = new Set<string>();
  const mutations: Array<
    ReplayOpaqueItem & { disposition: 'remove' | 'replace' }
  > = [];

  for (const item of opaqueItems) {
    const location = item.location;
    if (seenItemIds.has(item.id)) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'invalid-opaque-item',
          'Opaque review item ids must be unique.',
          item.id,
        ),
      };
    }
    seenItemIds.add(item.id);
    if (
      replayOpaqueItemId(
        location.fileId,
        location.rowOrdinal,
        location.jsonPointer,
        item.blockType,
      ) !== item.id
    ) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'invalid-opaque-item',
          'An opaque item id does not match its location and type.',
          item.id,
        ),
      };
    }
    if (item.disposition === 'replace' && item.replacement === null) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'missing-opaque-replacement',
          'An opaque replace decision requires a JSON replacement.',
          item.id,
        ),
      };
    }

    const originalRow = resolveReplayNativeRow(
      originalDraft,
      location.fileId,
      location.rowOrdinal,
    );
    const originalValue = originalRow
      ? resolveJsonPointer(
          originalRow.value,
          location.jsonPointer,
        )
      : undefined;
    if (
      originalValue === undefined ||
      originalValue === null ||
      typeof originalValue !== 'object' ||
      Array.isArray(originalValue) ||
      (originalValue as Record<string, unknown>).type !== item.blockType
    ) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'missing-opaque-location',
          'A reviewed opaque location no longer exists.',
          item.id,
        ),
      };
    }

    if (
      item.disposition === 'remove' ||
      item.disposition === 'replace'
    ) {
      mutations.push(
        item as ReplayOpaqueItem & {
          disposition: 'remove' | 'replace';
        },
      );
    }
  }

  for (const item of mutations.sort(opaqueMutationOrder)) {
    const location = item.location;
    const row = resolveReplayNativeRow(
      cloned.draft,
      location.fileId,
      location.rowOrdinal,
    );
    const changed =
      row &&
      mutateJsonPointer(
        row.value,
        location.jsonPointer,
        item.disposition,
        item.replacement,
      );
    if (!changed) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'missing-opaque-location',
          'A reviewed opaque location no longer exists.',
          item.id,
        ),
      };
    }
  }

  for (const item of opaqueItems) {
    if (
      (item.disposition === 'remove' ||
        item.disposition === 'replace') &&
      !cloned.draft.omissions.some(
        (omission) => omission.relatedId === item.id,
      )
    ) {
      cloned.draft.omissions.push({
        id: `reviewed-opaque-${item.id}`,
        category: 'opaque-content',
        reason: 'removed-after-review',
        disclosure:
          item.disposition === 'remove'
            ? `Opaque ${item.blockType} content was explicitly removed during replay review.`
            : `Opaque ${item.blockType} content was explicitly replaced during replay review.`,
        relatedId: item.id,
      });
    }
  }

  return {
    ok: true,
    draft: cloned.draft,
    pendingOpaqueItems: opaqueItems.filter(
      (item) => item.disposition === 'pending',
    ).length,
  };
}

export function applyReplayOpaqueDecisions(
  draft: ReplayBundleDraft,
  opaqueItems: ReplayOpaqueItem[],
): ReplayOpaqueEditResult {
  return applyReplayOpaqueDecisionsAgainstOriginal(
    draft,
    opaqueItems,
    draft,
  );
}

const NORMALIZATION_CATEGORIES = new Set<NormalizationCategory>([
  'path',
  'username',
  'email',
  'ipv4',
  'ipv6',
]);

function replayApplyFailure(
  code: ReplayApplyErrorCode,
  message: string,
  findingId: string | null = null,
): ReplayDispositionApplyResult {
  return {
    ok: false,
    error: makeReplayApplyError(code, message, findingId),
  };
}

function makeReplayApplyError(
  code: ReplayApplyErrorCode,
  message: string,
  findingId: string | null = null,
): ReplayApplyError {
  return {
    schemaVersion: '1.0.0',
    code,
    message,
    findingId,
  };
}

function mapperMatchesReport(
  draft: ReplayBundleDraft,
  report: ReplaySanitizationReport,
  mapper: PseudonymMapper,
): ReplayApplyError | undefined {
  if (!(mapper instanceof PseudonymMapper)) {
    return makeReplayApplyError(
      'mapper-mismatch',
      'The replay pseudonym mapper is not valid.',
    );
  }

  for (const finding of report.findings) {
    if (finding.layer !== 'normalization') continue;
    if (
      finding.category === null ||
      !NORMALIZATION_CATEGORIES.has(
        finding.category as NormalizationCategory,
      )
    ) {
      return makeReplayApplyError(
        'mapper-mismatch',
        'A normalization finding has no recognized mapper category.',
        finding.id,
      );
    }
    const matched = resolveReplayLocationSpan(draft, finding.location);
    const expected =
      matched === undefined
        ? undefined
        : mapper.peek(
            finding.category as NormalizationCategory,
            matched,
          );
    if (expected !== finding.replacementSuggestion) {
      return makeReplayApplyError(
        'mapper-mismatch',
        'The replay report does not match the supplied pseudonym mapper.',
        finding.id,
      );
    }
  }
  return undefined;
}

function redactReviewFindings(
  findings: ReplayFinding[],
): ReplayFinding[] {
  return findings.map((finding) => ({
    ...structuredClone(finding),
    matchPreview: `[redacted:${finding.layer}:${finding.ruleId}]`,
  }));
}

function redactReviewOpaqueItems(
  opaqueItems: ReplayOpaqueItem[],
): ReplayOpaqueItem[] {
  return opaqueItems.map((item) => ({
    ...structuredClone(item),
    matchPreview: `[opaque:${item.blockType}]`,
    replacement: null,
  }));
}

function immutableReplayFinding(finding: ReplayFinding): unknown {
  const { disposition, ...immutable } = finding;
  void disposition;
  return immutable;
}

function immutableReplayOpaqueItem(item: ReplayOpaqueItem): unknown {
  const { disposition, replacement, ...immutable } = item;
  void disposition;
  void replacement;
  return immutable;
}

function immutableItemsMatchPositionally<T>(
  reviewed: T[],
  original: T[],
  immutable: (item: T) => unknown,
): boolean {
  if (reviewed.length !== original.length) return false;
  return reviewed.every((item, index) =>
    isDeepStrictEqual(immutable(item), immutable(original[index]!)),
  );
}

function reportItemsMatchOriginalScan(
  report: ReplaySanitizationReport,
  original: ReplaySanitizationReport,
): boolean {
  return (
    immutableItemsMatchPositionally(
      report.findings,
      original.findings,
      immutableReplayFinding,
    ) &&
    immutableItemsMatchPositionally(
      report.opaqueItems,
      original.opaqueItems,
      immutableReplayOpaqueItem,
    )
  );
}

function isExactAllowedBlockingFinding(
  finding: ReplayFinding,
  approved: ReplayFinding,
): boolean {
  return (
    approved.id === finding.id &&
    approved.ruleId === finding.ruleId &&
    approved.matchHash === finding.matchHash &&
    approved.layer === finding.layer &&
    approved.blocking === finding.blocking &&
    isDeepStrictEqual(approved.location, finding.location)
  );
}

export function findBlockingReconciliationFailure(
  findings: ReplayFinding[],
  allowed: ReplayFinding[],
): ReplayFinding | undefined {
  const unmatchedApprovals = [...allowed];
  for (const finding of findings) {
    if (!finding.blocking) continue;
    const approvedIndex = unmatchedApprovals.findIndex((approved) =>
      isExactAllowedBlockingFinding(finding, approved),
    );
    if (approvedIndex === -1) return finding;
    unmatchedApprovals.splice(approvedIndex, 1);
  }
  return undefined;
}

type ProjectAllowedBlockingFindingsResult =
  | { ok: true; findings: ReplayFinding[] }
  | { ok: false; error: ReplayApplyError };

function spansOverlap(
  left: ReplayFindingLocation['span'],
  right: ReplayFindingLocation['span'],
): boolean {
  return left.start < right.end && right.start < left.end;
}

function tokensEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

function tokensArePrefix(
  prefix: string[],
  value: string[],
): boolean {
  return (
    prefix.length <= value.length &&
    prefix.every((token, index) => token === value[index])
  );
}

/**
 * Move a native string pointer through the exact opaque mutations that will
 * later be applied. Array removals shift later siblings; object removals and
 * replacements do not. An ancestor mutation invalidates the approval because
 * any content subsequently observed there comes from the opaque decision.
 */
function projectNativePointerThroughOpaqueMutations(
  draft: ReplayBundleDraft,
  location: Extract<ReplayFindingLocation, { kind: 'native' }>,
  opaqueItems: ReplayOpaqueItem[],
): string | undefined {
  const projectedTokens = parseJsonPointerTokens(location.jsonPointer);
  if (projectedTokens === undefined) return undefined;

  const mutations = opaqueItems
    .filter(
      (item) =>
        (item.disposition === 'remove' ||
          item.disposition === 'replace') &&
        item.location.fileId === location.fileId &&
        item.location.rowOrdinal === location.rowOrdinal,
    )
    .sort(opaqueMutationOrder);

  const originalRow = resolveReplayNativeRow(
    draft,
    location.fileId,
    location.rowOrdinal,
  );
  if (!originalRow) return undefined;

  for (const mutation of mutations) {
    const mutationTokens = parseJsonPointerTokens(
      mutation.location.jsonPointer,
    );
    if (mutationTokens === undefined || mutationTokens.length === 0) {
      return undefined;
    }

    if (tokensArePrefix(mutationTokens, projectedTokens)) {
      return undefined;
    }
    if (mutation.disposition !== 'remove') continue;

    const mutationParentTokens = mutationTokens.slice(0, -1);
    const originalParent = resolveJsonPointer(
      originalRow.value,
      jsonPointerFromTokens(mutationParentTokens),
    );
    if (
      !Array.isArray(originalParent) ||
      projectedTokens.length <= mutationParentTokens.length ||
      !tokensEqual(
        mutationParentTokens,
        projectedTokens.slice(0, mutationParentTokens.length),
      )
    ) {
      continue;
    }

    const removedToken = mutationTokens.at(-1)!;
    const projectedSiblingToken =
      projectedTokens[mutationParentTokens.length]!;
    if (
      !/^(0|[1-9]\d*)$/.test(removedToken) ||
      !/^(0|[1-9]\d*)$/.test(projectedSiblingToken)
    ) {
      continue;
    }
    const removedIndex = Number(removedToken);
    const projectedIndex = Number(projectedSiblingToken);
    if (removedIndex < projectedIndex) {
      projectedTokens[mutationParentTokens.length] = String(
        projectedIndex - 1,
      );
    }
  }

  return jsonPointerFromTokens(projectedTokens);
}

/**
 * Move retained blocking spans from the reviewed draft coordinate space into
 * the post-edit coordinate space. Selected edits can shift spans in the same
 * string, while reviewed opaque array removals can shift native pointers.
 */
function projectAllowedBlockingFindings(
  draft: ReplayBundleDraft,
  findings: ReplayFinding[],
  opaqueItems: ReplayOpaqueItem[],
): ProjectAllowedBlockingFindingsResult {
  const groups = new Map<string, ReplayFinding[]>();
  for (const finding of findings) {
    const key = locationKey(finding.location);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }

  const projected: ReplayFinding[] = [];
  const projectedByLocation = new Map<string, ReplayFinding[]>();
  const reconciliationKeys = new Set<string>();
  for (const approved of findings) {
    if (!approved.blocking || approved.disposition !== 'allow') {
      continue;
    }

    const originalSpan = approved.location.span;
    let shift = 0;
    const selectedEdits = selectReplayStringEdits(
      groups.get(locationKey(approved.location)) ?? [],
    );
    for (const edit of selectedEdits) {
      if (edit.end <= originalSpan.start) {
        shift += edit.text.length - (edit.end - edit.start);
        continue;
      }
      if (edit.start >= originalSpan.end) continue;
      return {
        ok: false,
        error: makeReplayApplyError(
          'invalid-finding',
          'An allowed replay span overlaps a selected edit and cannot be projected unambiguously.',
          approved.id,
        ),
      };
    }

    const location = structuredClone(approved.location);
    location.span = {
      start: originalSpan.start + shift,
      end: originalSpan.end + shift,
    };
    if (location.kind === 'native') {
      const projectedPointer =
        projectNativePointerThroughOpaqueMutations(
          draft,
          location,
          opaqueItems,
        );
      if (projectedPointer === undefined) {
        continue;
      }
      location.jsonPointer = projectedPointer;
    }
    const projectedFinding: ReplayFinding = {
      ...structuredClone(approved),
      id: replayFindingId(location, approved.ruleId),
      location,
    };
    const reconciliationKey = JSON.stringify([
      projectedFinding.id,
      projectedFinding.ruleId,
      projectedFinding.matchHash,
    ]);
    if (reconciliationKeys.has(reconciliationKey)) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'invalid-finding',
          'Multiple allowed replay findings map to the same verification finding.',
          approved.id,
        ),
      };
    }

    const projectedLocationKey = locationKey(location);
    const locationFindings =
      projectedByLocation.get(projectedLocationKey) ?? [];
    if (
      locationFindings.some((finding) =>
        spansOverlap(finding.location.span, location.span),
      )
    ) {
      return {
        ok: false,
        error: makeReplayApplyError(
          'invalid-finding',
          'Projected allowed replay spans overlap and cannot be reconciled unambiguously.',
          approved.id,
        ),
      };
    }
    reconciliationKeys.add(reconciliationKey);
    locationFindings.push(projectedFinding);
    projectedByLocation.set(projectedLocationKey, locationFindings);
    projected.push(projectedFinding);
  }

  return { ok: true, findings: projected };
}

/**
 * Apply one reviewed replay report without mutating its draft or report.
 *
 * Report/draft/ruleset identities are checked before any edit. A locked gate
 * may return a preview, but only an unlocked gate can return a reviewed payload.
 */
export function applyReplayDispositions(
  input: ReplayBundleDraft,
  inputReport: ReplaySanitizationReport,
  mapper: PseudonymMapper,
  options: ReplayApplyOptions,
): ReplayDispositionApplyResult {
  const draftResult = ReplayBundleDraftSchema.safeParse(input);
  if (!draftResult.success) {
    return replayApplyFailure(
      'invalid-draft',
      'The ReplayBundle draft is invalid.',
    );
  }
  const reportResult =
    ReplaySanitizationReportSchema.safeParse(inputReport);
  if (!reportResult.success) {
    return replayApplyFailure(
      'invalid-report',
      'The replay sanitization report is invalid.',
    );
  }

  const draft = draftResult.data;
  const report = reportResult.data;
  if (report.draftId !== draft.draftId) {
    return replayApplyFailure(
      'draft-id-mismatch',
      'The replay report does not identify this draft.',
    );
  }
  if (report.draftContentHash !== hashReplayDraftContent(draft)) {
    return replayApplyFailure(
      'draft-content-mismatch',
      'The replay report was produced for different draft content.',
    );
  }
  if (
    options.expectedRulesetVersion.length === 0 ||
    options.ruleset.rulesetVersion !== options.expectedRulesetVersion ||
    report.sanitizationRulesetVersion !==
      options.expectedRulesetVersion ||
    draft.terminalManifestSeed.sanitization.rulesetVersion !==
      options.expectedRulesetVersion ||
    draft.terminalManifestSeed.sanitization.reportVersion !==
      report.reportVersion
  ) {
    return replayApplyFailure(
      'ruleset-mismatch',
      'The draft, report, and expected compiled ruleset identities differ.',
    );
  }

  const originalScan = scanReplayDraft(draft, options.ruleset, {
    generatedAt: report.generatedAt,
  });
  if (!originalScan.ok) {
    return replayApplyFailure(
      'post-apply-scan-failed',
      'The original ReplayBundle draft could not be re-scanned.',
    );
  }
  if (!reportItemsMatchOriginalScan(report, originalScan.report)) {
    return replayApplyFailure(
      'invalid-report',
      'The replay report findings or opaque items do not exactly match a fresh scan of the original draft.',
    );
  }

  const mapperError = mapperMatchesReport(draft, report, mapper);
  if (mapperError) return { ok: false, error: mapperError };

  const gate = computeReplayGate(report.findings, report.opaqueItems);
  const edited = applyReplayFindingEdits(draft, report.findings);
  if (!edited.ok) return edited;
  const projectedAllowedBlockingFindings =
    projectAllowedBlockingFindings(
      draft,
      report.findings,
      report.opaqueItems,
    );
  if (!projectedAllowedBlockingFindings.ok) {
    return {
      ok: false,
      error: projectedAllowedBlockingFindings.error,
    };
  }
  const opaqueApplied = applyReplayOpaqueDecisionsAgainstOriginal(
    edited.draft,
    report.opaqueItems,
    draft,
  );
  if (!opaqueApplied.ok) return opaqueApplied;

  const reviewedDraft = ReplayBundleDraftSchema.safeParse(
    opaqueApplied.draft,
  );
  if (!reviewedDraft.success) {
    return replayApplyFailure(
      'invalid-reviewed-output',
      'The reviewed replay draft is not schema-valid.',
    );
  }

  if (!gate.unlocked) {
    return {
      ok: true,
      draft: reviewedDraft.data,
      gate,
      sealablePayload: null,
    };
  }

  const hasUnresolvedPrivacyDecision = report.findings.some(
    (finding) =>
      finding.layer === 'normalization' &&
      (finding.disposition === 'pending' ||
        finding.disposition === 'allow'),
  );

  const verification = scanReplayDraft(
    reviewedDraft.data,
    options.ruleset,
    { generatedAt: report.generatedAt },
  );
  if (!verification.ok) {
    return replayApplyFailure(
      'post-apply-scan-failed',
      'The reviewed replay draft could not be verified.',
    );
  }
  const unapprovedBlockingFinding = findBlockingReconciliationFailure(
    verification.report.findings,
    projectedAllowedBlockingFindings.findings,
  );
  if (unapprovedBlockingFinding) {
    return replayApplyFailure(
      'surviving-blocking-canary',
      'Post-apply verification found a blocking value without an exact allow decision.',
      unapprovedBlockingFinding.id,
    );
  }

  if (
    hasUnresolvedPrivacyDecision ||
    verification.report.findings.some(
      (finding) => finding.layer === 'normalization',
    )
  ) {
    return {
      ok: true,
      draft: reviewedDraft.data,
      gate,
      sealablePayload: null,
    };
  }

  const payloadResult = ReplayBundlePayloadSchema.safeParse({
    ...reviewedDraft.data,
    review: {
      schemaVersion: '1.0.0',
      draftId: draft.draftId,
      rulesetVersion: options.expectedRulesetVersion,
      reportVersion: report.reportVersion,
      decisionVersion: options.decisionVersion,
      reviewedDraftHash: `sha256:${createHash('sha256')
        .update(
          canonicalizeReplayReviewedDraft(reviewedDraft.data),
        )
        .digest('hex')}`,
      findings: redactReviewFindings(report.findings),
      opaqueItems: redactReviewOpaqueItems(report.opaqueItems),
      approvedAt: options.approvedAt ?? new Date().toISOString(),
      humanReviewPassed: true,
    },
  });
  if (!payloadResult.success) {
    return replayApplyFailure(
      'invalid-reviewed-output',
      'The reviewed replay payload is not schema-valid.',
    );
  }

  return {
    ok: true,
    draft: reviewedDraft.data,
    gate,
    sealablePayload: payloadResult.data,
  };
}
