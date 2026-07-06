import { createHash } from 'node:crypto';

import type { SanitizedSession } from '@mosga/contracts';

import { canonicalJson } from './canonical.js';
import { L3_DETECTORS } from './detectors.js';
import { shannonEntropy } from './entropy.js';
import { escapeRegExp } from './ingest.js';
import { PseudonymMapper } from './pseudonym.js';
import { redactPreview } from './redact.js';
import {
  type CompiledRuleset,
  type CustomRule,
  type Finding,
  type FindingField,
  type FindingLocation,
  type NonTextItem,
  type NormalizedRule,
  type RuleAllowlist,
  type SanitizationReport,
} from './schemas.js';

export const REPORT_VERSION = '0.1.0';

/** Per-field wall-clock ceiling; exceeding it yields a needs-review finding. */
const FIELD_TIME_BUDGET_MS = 250;
/** Fields longer than this are scanned up to the cap; the tail yields a needs-review finding. */
const MAX_SCAN_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Traversal (task 4.1)
// ---------------------------------------------------------------------------

interface ScanUnit {
  field: FindingField;
  scope: 'message' | 'session';
  messageIndex?: number;
  messageUuid?: string;
  toolCallId?: string;
  toolResultIndex?: number;
  text: string;
}

/** Walk a session structure-aware, yielding every scannable string position. */
export function collectScanUnits(session: SanitizedSession): ScanUnit[] {
  const units: ScanUnit[] = [];

  if (session.session.cwd) {
    units.push({ field: 'sessionCwd', scope: 'session', text: session.session.cwd });
  }
  if (session.session.title) {
    units.push({ field: 'sessionTitle', scope: 'session', text: session.session.title });
  }

  session.messages.forEach((msg, messageIndex) => {
    const base = { scope: 'message' as const, messageIndex, messageUuid: msg.sdkUuid };
    const stringFields: Array<[FindingField, string | undefined]> = [
      ['content', msg.content],
      ['thinking', msg.thinking],
      ['commandName', msg.commandName],
      ['commandMessage', msg.commandMessage],
      ['commandArgs', msg.commandArgs],
    ];
    for (const [field, text] of stringFields) {
      if (text) units.push({ ...base, field, text });
    }

    for (const call of msg.toolCalls ?? []) {
      const inputText = canonicalJson(call.input ?? {});
      if (inputText && inputText !== '{}') {
        units.push({ ...base, field: 'toolCallInput', toolCallId: call.id, text: inputText });
      }
      if (call.result) {
        units.push({ ...base, field: 'toolCallResult', toolCallId: call.id, text: call.result });
      }
    }

    (msg.toolResults ?? []).forEach((res, toolResultIndex) => {
      if (res.content) {
        units.push({ ...base, field: 'toolResultContent', toolResultIndex, text: res.content });
      }
    });
  });

  return units;
}

// ---------------------------------------------------------------------------
// Compiled rule matchers (L1) — regex + keyword pre-filter + entropy + allowlist
// ---------------------------------------------------------------------------

interface CompiledMatcher {
  rule: NormalizedRule;
  regex: RegExp;
}

function withFlags(source: string, flags: string, add: string): RegExp {
  let f = flags;
  for (const ch of add) if (!f.includes(ch)) f += ch;
  return new RegExp(source, f);
}

/** A rule whose compiled `regexSource` failed to build on THIS runtime. */
export interface RulesetWarning {
  ruleId: string;
  reason: string;
  /** `keyword`: still runs via a keyword literal matcher. `none`: cannot run. */
  degradedTo: 'keyword' | 'none';
}

interface CompileOutcome {
  matchers: CompiledMatcher[];
  warnings: RulesetWarning[];
}

/**
 * Compile every rule's translated pattern for scanning. The compiled artifact is
 * loaded by BOTH the tool and slice-4 CI (design D2); a `regexSource` that built
 * on the authoring runtime but not on the consumer's (e.g. a construct requiring
 * a newer engine) must NOT vanish silently — that would break the "no silent
 * truncation" invariant at exactly the cross-environment boundary the artifact
 * exists to serve. On a compile failure we degrade in place to the rule's
 * keyword literal matcher (so it still runs, block-on-hit) when keywords exist,
 * else record it as unrunnable — and always surface it as a warning.
 */
function compileMatchers(rules: NormalizedRule[]): CompileOutcome {
  const matchers: CompiledMatcher[] = [];
  const warnings: RulesetWarning[] = [];
  for (const rule of rules) {
    try {
      matchers.push({ rule, regex: withFlags(rule.regexSource, rule.flags, 'gd') });
    } catch (err) {
      const reason = (err as Error).message;
      if (rule.keywords.length > 0) {
        const alternation = rule.keywords.map(escapeRegExp).join('|');
        try {
          matchers.push({
            rule: {
              ...rule,
              translation: {
                status: 'degraded',
                notes: `runtime compile failure (${reason}); degraded to keyword literal matcher`,
              },
            },
            regex: new RegExp(`(?:${alternation})`, 'gid'),
          });
          warnings.push({ ruleId: rule.id, reason, degradedTo: 'keyword' });
          continue;
        } catch {
          // keyword alternation itself failed — fall through to `none`.
        }
      }
      warnings.push({ ruleId: rule.id, reason, degradedTo: 'none' });
    }
  }
  return { matchers, warnings };
}

function allowlisted(
  secret: string,
  fullMatch: string,
  line: string,
  lists: Array<RuleAllowlist | undefined>,
): boolean {
  for (const al of lists) {
    if (!al) continue;
    for (const sw of al.stopwords) {
      if (sw && secret.toLowerCase().includes(sw.toLowerCase())) return true;
    }
    for (const rx of al.regexes) {
      // gitleaks allowlist regexTarget: 'line' → whole field line, 'match' →
      // the full regex match, default ('secret') → the reported secret. m2 fix:
      // 'match' now tests the full match, not the (possibly narrower) secret.
      const target =
        al.regexTarget === 'line' ? line : al.regexTarget === 'match' ? fullMatch : secret;
      try {
        if (new RegExp(rx).test(target)) return true;
      } catch {
        // ignore an un-compilable allowlist regex
      }
    }
  }
  return false;
}

interface Hit {
  ruleId: string;
  span: { start: number; end: number };
  secretValue: string;
}

/** Run one rule's regex over a field, applying keyword/entropy/allowlist gates. */
function matchRule(
  matcher: CompiledMatcher,
  text: string,
  globalAllowlist: RuleAllowlist | undefined,
): Hit[] {
  const { rule, regex } = matcher;
  // Keyword pre-filter (fidelity + speed): a rule with keywords only runs
  // against text containing one of them (case-insensitive).
  if (rule.keywords.length > 0) {
    const lower = text.toLowerCase();
    if (!rule.keywords.some((k) => lower.includes(k.toLowerCase()))) return [];
  }

  const hits: Hit[] = [];
  regex.lastIndex = 0;
  for (const m of text.matchAll(regex)) {
    if (m.index === undefined) continue;
    const indices = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> })
      .indices;

    // The "secret" for span/entropy/stopword purposes is the `secretGroup`
    // capture when set, else capture group 1 when present, else the whole match.
    //
    // m1 — INTENTIONAL DEVIATION from gitleaks' naive whole-match default,
    // documented rather than "fixed": using the whole match here regresses
    // detection. gitleaks' generic-api-key stopword list contains "password",
    // and the whole match (`password = "<key>"`) then trips that stopword and
    // falsely suppresses a real key; the capture group (the value alone) does
    // not. Group-1 is also higher-recall (better per-char entropy) and yields a
    // tighter redaction span. `fullMatch` is still available below for the
    // allowlist `regexTarget:'match'` case (m2).
    const fullMatch = m[0];
    let span: { start: number; end: number };
    let secretValue: string;
    const group = rule.secretGroup ?? (m[1] !== undefined ? 1 : 0);
    const gi = indices?.[group];
    if (group > 0 && gi && m[group] !== undefined) {
      span = { start: gi[0], end: gi[1] };
      secretValue = m[group];
    } else {
      span = { start: m.index, end: m.index + fullMatch.length };
      secretValue = fullMatch;
    }

    // m4 fix — gitleaks skips a match whose entropy is <= the threshold
    // (i.e. requires strictly greater).
    if (rule.entropy !== undefined && shannonEntropy(secretValue) <= rule.entropy) continue;
    if (allowlisted(secretValue, fullMatch, text, [rule.allowlist, globalAllowlist])) continue;

    hits.push({ ruleId: rule.id, span, secretValue });
    if (m[0].length === 0) regex.lastIndex++; // guard against zero-width loops
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Finding id (task 4.6)
// ---------------------------------------------------------------------------

function findingId(location: FindingLocation, ruleId: string): string {
  const anchor = location.messageUuid ?? `idx:${location.messageIndex ?? 'session'}`;
  const key = [
    location.scope,
    anchor,
    location.field,
    location.toolCallId ?? '',
    location.toolResultIndex ?? '',
    location.span.start,
    location.span.end,
    ruleId,
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function locationOf(
  unit: ScanUnit,
  span: { start: number; end: number },
): FindingLocation {
  return {
    scope: unit.scope,
    messageIndex: unit.messageIndex,
    messageUuid: unit.messageUuid,
    field: unit.field,
    toolCallId: unit.toolCallId,
    toolResultIndex: unit.toolResultIndex,
    span,
  };
}

// ---------------------------------------------------------------------------
// Scan (tasks 4.2–4.9)
// ---------------------------------------------------------------------------

export interface ScanResult {
  report: SanitizationReport;
  mapper: PseudonymMapper;
  /** Rules that failed to compile on THIS runtime (never silently dropped). */
  rulesetWarnings: RulesetWarning[];
}

export interface ScanOptions {
  /** Override the report timestamp for deterministic tests. */
  generatedAt?: string;
}

export function scanSession(
  session: SanitizedSession,
  ruleset: CompiledRuleset,
  options: ScanOptions = {},
): ScanResult {
  const mapper = new PseudonymMapper();
  const { matchers, warnings: rulesetWarnings } = compileMatchers(ruleset.rules);
  const customMatchers = ruleset.customRules.map(compileCustom);
  const units = collectScanUnits(session);
  const findings: Finding[] = [];

  // Surface any rule that could not compile (and could not degrade to a keyword
  // matcher) as a blocking, gating finding — never a silent vanish (M3).
  for (const w of rulesetWarnings) {
    if (w.degradedTo !== 'none') continue;
    const location: FindingLocation = {
      scope: 'session',
      field: 'rulesetMeta',
      span: { start: 0, end: 0 },
    };
    findings.push({
      id: findingId(location, `ruleset-compile-error:${w.ruleId}`),
      layer: 'secrets',
      ruleId: 'ruleset-compile-error',
      location,
      matchPreview: `rule "${w.ruleId}" failed to compile on this runtime and has no keyword fallback; manual review required (${w.reason})`,
      replacementSuggestion: '',
      disposition: 'pending',
      blocking: true,
    });
  }

  for (const unit of units) {
    const full = unit.text;
    const truncated = full.length > MAX_SCAN_CHARS;
    const text = truncated ? full.slice(0, MAX_SCAN_CHARS) : full;
    const started = Date.now();
    let timedOut = false;

    // L1 secrets.
    for (const matcher of matchers) {
      if (Date.now() - started > FIELD_TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }
      for (const hit of matchRule(matcher, text, ruleset.globalAllowlist)) {
        const location = locationOf(unit, hit.span);
        findings.push({
          id: findingId(location, hit.ruleId),
          layer: 'secrets',
          ruleId: hit.ruleId,
          location,
          matchPreview: redactPreview(hit.secretValue),
          replacementSuggestion: `<SECRET:${hit.ruleId}>`,
          disposition: 'pending',
          blocking: true,
        });
      }
    }

    // L2 custom.
    if (!timedOut) {
      for (const cm of customMatchers) {
        if (Date.now() - started > FIELD_TIME_BUDGET_MS) {
          timedOut = true;
          break;
        }
        for (const hit of matchCustom(cm, text)) {
          const location = locationOf(unit, hit.span);
          findings.push({
            id: findingId(location, hit.ruleId),
            layer: 'custom',
            ruleId: hit.ruleId,
            location,
            matchPreview: redactPreview(hit.secretValue),
            replacementSuggestion: cm.rule.replacement ?? `<CUSTOM:${hit.ruleId}>`,
            disposition: 'pending',
            blocking: true,
          });
        }
      }
    }

    // L3 normalization.
    if (!timedOut) {
      for (const detector of L3_DETECTORS) {
        // Same per-field ceiling as L1/L2: if L3 is cut short, the redos-guard
        // finding below fires so a truncated normalization pass fails safe
        // toward review rather than silently under-normalizing (B1).
        if (Date.now() - started > FIELD_TIME_BUDGET_MS) {
          timedOut = true;
          break;
        }
        for (const m of detector.run(text)) {
          const location = locationOf(unit, { start: m.start, end: m.end });
          findings.push({
            id: findingId(location, detector.category),
            layer: 'normalization',
            ruleId: detector.category,
            category: detector.category,
            location,
            matchPreview: m.value,
            replacementSuggestion: mapper.map(detector.category, m.value),
            disposition: 'pending',
            blocking: false,
          });
        }
      }
    }

    // ReDoS / oversize guard → needs-review finding, never a silent skip.
    if (timedOut || truncated) {
      const span = { start: 0, end: Math.min(text.length, 1) };
      const location = locationOf(unit, span);
      findings.push({
        id: findingId(location, 'redos-guard'),
        layer: 'secrets',
        ruleId: 'redos-guard',
        location,
        matchPreview: timedOut
          ? 'scan-time ceiling hit; field needs manual review'
          : 'field exceeds scan size; tail needs manual review',
        replacementSuggestion: '',
        disposition: 'pending',
        blocking: true,
      });
    }
  }

  const nonTextItems = collectNonTextItems(session);
  const report = assembleReport(session, ruleset, findings, nonTextItems, options.generatedAt);
  return { report, mapper, rulesetWarnings };
}

// ---------------------------------------------------------------------------
// L2 custom matchers
// ---------------------------------------------------------------------------

interface CompiledCustom {
  rule: CustomRule;
  regex: RegExp;
}

function compileCustom(rule: CustomRule): CompiledCustom {
  const source = rule.kind === 'literal' ? escapeRegExp(rule.pattern) : rule.pattern;
  // Custom rules are always case-sensitive unless the author encodes flags in
  // their own pattern; literal company names should match verbatim.
  return { rule, regex: new RegExp(source, 'gd') };
}

function matchCustom(cm: CompiledCustom, text: string): Hit[] {
  const hits: Hit[] = [];
  cm.regex.lastIndex = 0;
  for (const m of text.matchAll(cm.regex)) {
    if (m.index === undefined) continue;
    hits.push({
      ruleId: cm.rule.id,
      span: { start: m.index, end: m.index + m[0].length },
      secretValue: m[0],
    });
    if (m[0].length === 0) cm.regex.lastIndex++;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Non-text propagation (task 4.7)
// ---------------------------------------------------------------------------

export function collectNonTextItems(session: SanitizedSession): NonTextItem[] {
  const items: NonTextItem[] = [];
  session.messages.forEach((msg, messageIndex) => {
    if (msg.nonTextContent) {
      items.push({
        messageIndex,
        messageUuid: msg.sdkUuid,
        blockTypes: msg.nonTextContent.blockTypes,
        disposition: 'pending',
      });
    }
  });
  return items;
}

// ---------------------------------------------------------------------------
// Report assembly + gate (task 4.8)
// ---------------------------------------------------------------------------

export function computeGate(
  findings: Finding[],
  nonTextItems: NonTextItem[],
): SanitizationReport['gate'] {
  const blocking = findings.filter((f) => f.blocking);
  const blockingPending = blocking.filter((f) => f.disposition === 'pending').length;
  const nonTextPending = nonTextItems.filter((n) => n.disposition === 'pending').length;
  return {
    blockingTotal: blocking.length,
    blockingPending,
    nonTextPending,
    unlocked: blockingPending === 0 && nonTextPending === 0,
  };
}

function assembleReport(
  session: SanitizedSession,
  ruleset: CompiledRuleset,
  findings: Finding[],
  nonTextItems: NonTextItem[],
  generatedAt: string | undefined,
): SanitizationReport {
  const secrets = findings.filter((f) => f.layer === 'secrets');
  const custom = findings.filter((f) => f.layer === 'custom');
  const normalization = findings.filter((f) => f.layer === 'normalization');

  const byCategory: Record<string, number> = {};
  for (const f of normalization) {
    const key = f.category ?? 'other';
    byCategory[key] = (byCategory[key] ?? 0) + 1;
  }

  return {
    reportVersion: REPORT_VERSION,
    sanitizationRulesetVersion: ruleset.rulesetVersion,
    sessionId: session.session.sessionId,
    generatedAt: generatedAt ?? new Date().toISOString(),
    findings,
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
    nonTextItems,
    gate: computeGate(findings, nonTextItems),
  };
}
