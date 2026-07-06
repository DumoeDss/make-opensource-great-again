import { createHash } from 'node:crypto';

import { parse as parseToml } from 'smol-toml';

import {
  GITLEAKS_VERSION,
  MOSGA_ALLOWLIST_STOPWORDS,
  MOSGA_L3_VERSION,
  loadVendoredGitleaksToml,
} from './gitleaks.js';
import {
  type CompiledRuleset,
  type CustomRule,
  CustomRuleSchema,
  type DegradedEntry,
  type NormalizedRule,
  type RuleAllowlist,
} from './schemas.js';
import { translateRe2ToJs } from './translate.js';

/** Escape a literal string so it matches verbatim as a RegExp. */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// TOML parse (task 3.2)
// ---------------------------------------------------------------------------

interface RawRule {
  id?: string;
  description?: string;
  regex?: string;
  keywords?: string[];
  entropy?: number;
  secretGroup?: number;
  allowlist?: unknown;
  allowlists?: unknown[];
}

export interface ParsedGitleaks {
  rules: RawRule[];
  globalAllowlist: RuleAllowlist | undefined;
}

function normalizeAllowlist(raw: unknown): RuleAllowlist | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  const regexes = Array.isArray(a.regexes) ? (a.regexes as string[]) : [];
  const stopwords = Array.isArray(a.stopwords) ? (a.stopwords as string[]) : [];
  const description = typeof a.description === 'string' ? a.description : undefined;
  const regexTarget =
    a.regexTarget === 'match' || a.regexTarget === 'line' || a.regexTarget === 'secret'
      ? a.regexTarget
      : undefined;
  if (regexes.length === 0 && stopwords.length === 0) {
    return description || regexTarget ? { description, regexes, stopwords, regexTarget } : undefined;
  }
  return { description, regexes, stopwords, regexTarget };
}

/** Merge multiple allowlists (rule may carry `allowlist` and/or `allowlists[]`). */
function mergeAllowlists(rule: RawRule): RuleAllowlist | undefined {
  const parts: RuleAllowlist[] = [];
  const single = normalizeAllowlist(rule.allowlist);
  if (single) parts.push(single);
  if (Array.isArray(rule.allowlists)) {
    for (const entry of rule.allowlists) {
      const al = normalizeAllowlist(entry);
      if (al) parts.push(al);
    }
  }
  if (parts.length === 0) return undefined;
  return {
    regexes: parts.flatMap((p) => p.regexes),
    stopwords: parts.flatMap((p) => p.stopwords),
    regexTarget: parts.find((p) => p.regexTarget)?.regexTarget,
  };
}

export function parseGitleaksToml(tomlText: string): ParsedGitleaks {
  const doc = parseToml(tomlText) as Record<string, unknown>;
  const rawRules = Array.isArray(doc.rules) ? (doc.rules as RawRule[]) : [];
  return {
    rules: rawRules,
    globalAllowlist: normalizeAllowlist(doc.allowlist),
  };
}

// ---------------------------------------------------------------------------
// Rule ingestion: translate + degradation ladder (tasks 3.3, 3.4)
// ---------------------------------------------------------------------------

export interface IngestedRules {
  rules: NormalizedRule[];
  degraded: DegradedEntry[];
  globalAllowlist: RuleAllowlist | undefined;
}

/**
 * Translate every gitleaks rule to a scan-ready `NormalizedRule`, applying the
 * degradation ladder (design D3) so every rule ends in exactly one recorded
 * state — never silently dropped. Rule-count conservation is guaranteed: each
 * raw rule yields exactly one normalized rule.
 */
export function ingestGitleaksRules(parsed: ParsedGitleaks): IngestedRules {
  const rules: NormalizedRule[] = [];
  const degraded: DegradedEntry[] = [];

  parsed.rules.forEach((raw, index) => {
    const id = raw.id && raw.id.length > 0 ? raw.id : `unnamed-rule-${index}`;
    const description = raw.description ?? '';
    const keywords = Array.isArray(raw.keywords) ? raw.keywords : [];
    const allowlist = mergeAllowlists(raw);
    const base = {
      id,
      description,
      keywords,
      entropy: raw.entropy,
      secretGroup: raw.secretGroup,
      allowlist,
    };

    if (!raw.regex || raw.regex.length === 0) {
      // No regex at all — degrade to keywords, else disable.
      pushDegraded(id, keywords, 'rule carries no regex', base, rules, degraded);
      return;
    }

    const t = translateRe2ToJs(raw.regex);
    if (t.ok) {
      rules.push({
        ...base,
        regexSource: t.regexSource,
        flags: t.flags,
        translation: { status: t.status, notes: t.notes },
      });
      return;
    }

    // Untranslatable regex → degradation ladder.
    pushDegraded(id, keywords, t.reason, base, rules, degraded);
  });

  return { rules, degraded, globalAllowlist: parsed.globalAllowlist };
}

function pushDegraded(
  id: string,
  keywords: string[],
  reason: string,
  base: Omit<NormalizedRule, 'regexSource' | 'flags' | 'translation'>,
  rules: NormalizedRule[],
  degraded: DegradedEntry[],
): void {
  if (keywords.length > 0) {
    // Degrade to a case-insensitive literal keyword matcher (still block-on-hit
    // so a human sees obvious cases).
    const alternation = keywords.map(escapeRegExp).join('|');
    rules.push({
      ...base,
      regexSource: `(?:${alternation})`,
      flags: 'i',
      translation: {
        status: 'degraded',
        notes: `regex untranslatable (${reason}); degraded to keyword literal matcher`,
      },
    });
    degraded.push({
      id,
      status: 'degraded',
      reason: `${reason}; using keyword literal matcher`,
    });
  } else {
    // No usable keywords → disabled with a reason. Matches nothing.
    rules.push({
      ...base,
      regexSource: '(?!x)x', // never matches
      flags: '',
      translation: { status: 'disabled', notes: `disabled: ${reason}; no keywords to fall back to` },
    });
    degraded.push({
      id,
      status: 'disabled',
      reason: `${reason}; no keywords to fall back to`,
    });
  }
}

// ---------------------------------------------------------------------------
// Custom rules (task 3.5)
// ---------------------------------------------------------------------------

export interface CustomRuleError {
  id: string;
  error: string;
}

export interface LoadedCustomRules {
  rules: CustomRule[];
  errors: CustomRuleError[];
}

/**
 * Load user custom rules (Layer 2). Literal entries are kept as-is (matched
 * regex-escaped at scan time); regex entries go through the same compatibility
 * validator as gitleaks rules. An invalid regex is reported (id + error) and
 * skipped — never fatal.
 */
export function loadCustomRules(entries: unknown[]): LoadedCustomRules {
  const rules: CustomRule[] = [];
  const errors: CustomRuleError[] = [];

  entries.forEach((entry, index) => {
    const parsed = CustomRuleSchema.safeParse(entry);
    if (!parsed.success) {
      const id =
        entry && typeof entry === 'object' && 'id' in entry
          ? String((entry as { id: unknown }).id)
          : `custom-${index}`;
      errors.push({ id, error: `invalid custom rule shape: ${parsed.error.message}` });
      return;
    }
    const rule = parsed.data;
    if (rule.kind === 'regex') {
      const t = translateRe2ToJs(rule.pattern);
      if (!t.ok) {
        errors.push({ id: rule.id, error: t.reason });
        return;
      }
    }
    rules.push(rule);
  });

  return { rules, errors };
}

// ---------------------------------------------------------------------------
// Compiled artifact (task 3.6)
// ---------------------------------------------------------------------------

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export interface CompileOptions {
  /** Raw gitleaks TOML; defaults to the vendored file. */
  tomlText?: string;
  /** User custom rule entries (Layer 2). */
  customRules?: unknown[];
  /** Override the generated timestamp (for deterministic tests). */
  generatedAt?: string;
}

/**
 * Ingest gitleaks + custom rules into the compiled ruleset artifact both the
 * tool and slice-4 CI load. `rulesetVersion` is a stable composite id so a
 * report/envelope stamped with it can be checked for parity.
 */
export function compileRuleset(options: CompileOptions = {}): CompiledRuleset {
  const tomlText = options.tomlText ?? loadVendoredGitleaksToml();
  const parsed = parseGitleaksToml(tomlText);
  const ingested = ingestGitleaksRules(parsed);
  const custom = loadCustomRules(options.customRules ?? []);

  // Merge mosga's documented example-key allowlist into the global allowlist.
  const globalAllowlist: RuleAllowlist = {
    description: ingested.globalAllowlist?.description,
    regexes: ingested.globalAllowlist?.regexes ?? [],
    stopwords: [
      ...(ingested.globalAllowlist?.stopwords ?? []),
      ...MOSGA_ALLOWLIST_STOPWORDS,
    ],
    regexTarget: ingested.globalAllowlist?.regexTarget,
  };

  const customHash =
    custom.rules.length === 0
      ? 'none'
      : shortHash(
          custom.rules
            .map((r) => `${r.id}:${r.kind}:${r.pattern}`)
            .sort()
            .join('\n'),
        );

  const rulesetVersion = `gitleaks@${GITLEAKS_VERSION}+mosga-l3@${MOSGA_L3_VERSION}+custom@${customHash}`;

  return {
    rulesetVersion,
    gitleaksVersion: GITLEAKS_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    rules: ingested.rules,
    customRules: custom.rules,
    globalAllowlist,
    degraded: ingested.degraded,
  };
}
