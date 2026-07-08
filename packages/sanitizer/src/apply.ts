import type { SanitizedSession } from '@mosga/contracts';

import { canonicalJson } from './canonical.js';
import type { PseudonymMapper } from './pseudonym.js';
import { computeGate } from './scan.js';
import type {
  Disposition,
  Finding,
  NormalizationCategory,
  SanitizationReport,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Disposition helpers + batch operations (task 5.3)
// ---------------------------------------------------------------------------

/** Return a new report with `disposition` set on findings matching `predicate`. */
export function setDispositions(
  report: SanitizationReport,
  predicate: (f: Finding) => boolean,
  disposition: Disposition,
): SanitizationReport {
  const findings = report.findings.map((f) =>
    predicate(f) ? { ...f, disposition } : f,
  );
  return recompute({ ...report, findings });
}

export function setFindingDisposition(
  report: SanitizationReport,
  findingId: string,
  disposition: Disposition,
): SanitizationReport {
  return setDispositions(report, (f) => f.id === findingId, disposition);
}

/** Batch-by-rule: one disposition across every finding sharing a `ruleId`. */
export function batchByRule(
  report: SanitizationReport,
  ruleId: string,
  disposition: Disposition,
): SanitizationReport {
  return setDispositions(report, (f) => f.ruleId === ruleId, disposition);
}

/** Batch-by-type: one disposition across every L3 finding sharing a `category`. */
export function batchByType(
  report: SanitizationReport,
  category: NormalizationCategory,
  disposition: Disposition,
): SanitizationReport {
  return setDispositions(report, (f) => f.category === category, disposition);
}

/** Set a non-text item's disposition (keep/remove/pending). */
export function setNonTextDisposition(
  report: SanitizationReport,
  messageUuid: string,
  disposition: 'pending' | 'keep' | 'remove',
): SanitizationReport {
  const nonTextItems = report.nonTextItems.map((n) =>
    n.messageUuid === messageUuid ? { ...n, disposition } : n,
  );
  return recompute({ ...report, nonTextItems });
}

/** Recompute the derived layerSummary pending counts + gate after edits. */
function recompute(report: SanitizationReport): SanitizationReport {
  const secrets = report.findings.filter((f) => f.layer === 'secrets');
  const custom = report.findings.filter((f) => f.layer === 'custom');
  const normalization = report.findings.filter((f) => f.layer === 'normalization');
  const byCategory: Record<string, number> = {};
  for (const f of normalization) {
    const key = f.category ?? 'other';
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }
  return {
    ...report,
    layerSummary: {
      secrets: {
        total: secrets.length,
        pending: secrets.filter((f) => f.disposition === 'pending').length,
      },
      custom: {
        total: custom.length,
        pending: custom.filter((f) => f.disposition === 'pending').length,
      },
      normalization: { total: normalization.length, byCategory },
    },
    gate: computeGate(report.findings, report.nonTextItems),
  };
}

// ---------------------------------------------------------------------------
// Apply engine (tasks 5.1, 5.2, 5.4, 5.5, 5.6)
// ---------------------------------------------------------------------------

/** Escape text for insertion inside a JSON string literal (no surrounding quotes). */
function jsonStringEscape(text: string): string {
  const quoted = JSON.stringify(text);
  return quoted.slice(1, -1);
}

/** Identifies the single resolved string a set of findings edit together. */
function fieldKey(f: Finding): string {
  const l = f.location;
  return [
    l.scope,
    l.messageIndex ?? '',
    l.field,
    l.toolCallId ?? '',
    l.toolResultIndex ?? '',
  ].join('|');
}

/**
 * Apply the replace/delete edits of a group of findings to one field string.
 *
 * `escapeReplacement` transforms replacement text for the field's escaping
 * context (used for `toolCallInput`, where an edit lands inside a JSON string
 * literal — M2).
 */
function editString(
  original: string,
  findings: Finding[],
  escapeReplacement: (text: string) => string = (t) => t,
): string {
  const edits = findings
    .filter((f) => f.disposition === 'replace' || f.disposition === 'delete')
    .map((f) => ({
      start: f.location.span.start,
      end: f.location.span.end,
      text: f.disposition === 'replace' ? escapeReplacement(f.replacementSuggestion) : '',
    }));

  // M1 fix — when two edits overlap, the OUTER (wider, containing) edit must win
  // and the nested one is dropped: a `<PATH_1>` replacement subsumes its nested
  // `<USER_1>`, so replacing both must not leave the directory/project name
  // exposed. Sort by start ascending, then by end DESCENDING so a containing
  // span is considered before the span it contains; greedily keep only
  // non-overlapping edits (the first/outer one at each region).
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: typeof edits = [];
  let coveredEnd = -1;
  for (const e of edits) {
    if (e.start >= coveredEnd) {
      selected.push(e);
      coveredEnd = Math.max(coveredEnd, e.end);
    }
    // else: overlaps an already-selected outer edit → drop the nested one.
  }

  // Apply in descending start order so earlier offsets stay valid.
  selected.sort((a, b) => b.start - a.start);
  let result = original;
  for (const e of selected) {
    result = result.slice(0, e.start) + e.text + result.slice(e.end);
  }
  return result;
}

export interface ApplyResult {
  session: SanitizedSession;
  stamped: boolean;
  gate: SanitizationReport['gate'];
}

/**
 * Apply a report's dispositions to a session, producing a NEW session (design
 * D8). Blocking findings still `pending` keep the gate locked: the engine then
 * returns a partially-applied PREVIEW session (`meta.sanitized:false`) and never
 * a stamped one. Once every blocking finding and non-text item is dispositioned,
 * it emits the stamped export-ready session.
 */
export function applyDispositions(
  session: SanitizedSession,
  report: SanitizationReport,
  mapper: PseudonymMapper,
): ApplyResult {
  const gate = computeGate(report.findings, report.nonTextItems);
  const clone: SanitizedSession = structuredClone(session);

  // Group findings by the field string they edit.
  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = fieldKey(f);
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }

  for (const [, findings] of groups) {
    const current = readField(clone, findings[0]);
    if (current === undefined) continue;
    // toolCallInput edits land inside a JSON string literal, so replacement text
    // must be JSON-string-escaped or a value containing a quote/brace/backslash
    // would break the serialization (M2).
    const escaper =
      findings[0].location.field === 'toolCallInput' ? jsonStringEscape : undefined;
    const edited = editString(current, findings, escaper);
    if (edited !== current) writeField(clone, findings[0], edited);
  }

  // Honor non-text dispositions: `remove` drops the marker per explicit choice;
  // default keep-and-confirm retains it. Never auto-strip.
  for (const item of report.nonTextItems) {
    if (item.disposition === 'remove') {
      const msg = clone.messages[item.messageIndex];
      if (msg) delete msg.nonTextContent;
    }
  }

  if (gate.unlocked) {
    clone.meta = {
      ...clone.meta,
      sanitized: true,
      sanitizationRulesetVersion: report.sanitizationRulesetVersion,
      contributorAlias: mapper.primaryContributorAlias(),
    };
    return { session: clone, stamped: true, gate };
  }

  // Locked → partial preview only, never stamped.
  clone.meta = { ...clone.meta, sanitized: false };
  return { session: clone, stamped: false, gate };
}

// ---------------------------------------------------------------------------
// Field read/write (task 5.2 — toolCallInput round-trips through canonical JSON)
// ---------------------------------------------------------------------------

function readField(session: SanitizedSession, f: Finding): string | undefined {
  const l = f.location;
  if (l.scope === 'session') {
    switch (l.field) {
      case 'sessionCwd':
        return session.session.cwd ?? undefined;
      case 'sessionTitle':
        return session.session.title ?? undefined;
      case 'sessionProjectKey':
        return session.session.projectKey;
      case 'sessionId':
        return session.session.sessionId;
      case 'sessionSourceId':
        return session.session.sourceId;
      case 'schemaVersion':
        return session.schemaVersion;
      case 'metaContributorAlias':
        return session.meta.contributorAlias;
      case 'metaSourceCli':
        return session.meta.sourceCli;
      case 'metaToolVersion':
        return session.meta.toolVersion;
      case 'metaExportedAt':
        return session.meta.exportedAt;
      case 'metaLicense':
        return session.meta.license ?? undefined;
      // rulesetMeta (non-span) and sessionUpdatedAt (number) have no writable
      // string; a finding there is acknowledge-only.
      default:
        return undefined;
    }
  }
  const msg = session.messages[l.messageIndex ?? -1];
  if (!msg) return undefined;
  switch (l.field) {
    case 'content':
      return msg.content;
    case 'thinking':
      return msg.thinking;
    case 'commandName':
      return msg.commandName;
    case 'commandMessage':
      return msg.commandMessage;
    case 'commandArgs':
      return msg.commandArgs;
    case 'toolCallInput': {
      const call = msg.toolCalls?.find((c) => c.id === l.toolCallId);
      return call ? canonicalJson(call.input ?? {}) : undefined;
    }
    case 'toolCallResult':
      return msg.toolCalls?.find((c) => c.id === l.toolCallId)?.result;
    case 'toolResultContent':
      return msg.toolResults?.[l.toolResultIndex ?? -1]?.content;
    default:
      return undefined;
  }
}

function writeField(session: SanitizedSession, f: Finding, value: string): void {
  const l = f.location;
  if (l.scope === 'session') {
    switch (l.field) {
      case 'sessionCwd':
        session.session.cwd = value;
        break;
      case 'sessionTitle':
        session.session.title = value;
        break;
      case 'sessionProjectKey':
        session.session.projectKey = value;
        break;
      case 'sessionId':
        session.session.sessionId = value;
        break;
      case 'sessionSourceId':
        session.session.sourceId = value;
        break;
      case 'schemaVersion':
        session.schemaVersion = value;
        break;
      case 'metaContributorAlias':
        session.meta.contributorAlias = value;
        break;
      // `sourceCli` is a narrow enum; a human replace/delete writes a sanitized
      // literal (e.g. a redaction placeholder) intentionally outside the enum,
      // so cast to land the edit rather than silently no-op (no-op-leak guard).
      case 'metaSourceCli':
        session.meta.sourceCli = value as typeof session.meta.sourceCli;
        break;
      case 'metaToolVersion':
        session.meta.toolVersion = value;
        break;
      case 'metaExportedAt':
        session.meta.exportedAt = value;
        break;
      case 'metaLicense':
        session.meta.license = value;
        break;
      // rulesetMeta + sessionUpdatedAt (number) have no writer.
      default:
        break;
    }
    return;
  }
  const msg = session.messages[l.messageIndex ?? -1];
  if (!msg) return;
  switch (l.field) {
    case 'content':
      msg.content = value;
      break;
    case 'thinking':
      msg.thinking = value;
      break;
    case 'commandName':
      msg.commandName = value;
      break;
    case 'commandMessage':
      msg.commandMessage = value;
      break;
    case 'commandArgs':
      msg.commandArgs = value;
      break;
    case 'toolCallInput': {
      const call = msg.toolCalls?.find((c) => c.id === l.toolCallId);
      if (call) {
        // M2 fix — never let a malformed re-serialization crash the whole apply
        // pass. Escaping (in editString) keeps string-value edits well-formed;
        // this is the safety net for a delete that crosses a JSON structural
        // boundary. On failure, leave the input unedited (the caller's gate keeps
        // the session unstamped, failing safe toward review).
        try {
          call.input = JSON.parse(value) as Record<string, unknown>;
        } catch {
          // keep original call.input untouched
        }
      }
      break;
    }
    case 'toolCallResult': {
      const call = msg.toolCalls?.find((c) => c.id === l.toolCallId);
      if (call) call.result = value;
      break;
    }
    case 'toolResultContent': {
      const res = msg.toolResults?.[l.toolResultIndex ?? -1];
      if (res) res.content = value;
      break;
    }
    default:
      break;
  }
}
