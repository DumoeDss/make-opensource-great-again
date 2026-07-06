/**
 * Presentation helpers over the sanitizer finding model.
 */
import type { Finding, SanitizationReport } from '../api/types';

/**
 * A meta / engine finding with no editable text — `ruleset-compile-error`,
 * `redos-guard`, or any `field:'rulesetMeta'`. Its only meaningful disposition
 * is `allow` (acknowledge), which is what clears it from the gate (design D5).
 */
export function isMetaFinding(f: Finding): boolean {
  return (
    f.ruleId === 'ruleset-compile-error' ||
    f.ruleId === 'redos-guard' ||
    f.location.field === 'rulesetMeta'
  );
}

/** Human-readable structural position from a finding's `location`. */
export function describeLocation(f: Finding): string {
  const l = f.location;
  if (l.scope === 'session') {
    return l.field === 'rulesetMeta' ? 'ruleset (engine)' : `session.${l.field}`;
  }
  const where = l.messageIndex !== undefined ? `message[${l.messageIndex}]` : 'message';
  const span = `[${l.span.start}–${l.span.end}]`;
  const tool = l.toolCallId ? ` (tool ${l.toolCallId})` : '';
  return `${where}.${l.field}${tool} ${span}`;
}

/** Blocking findings, in a stable order (secrets, then custom, then meta). */
export function blockingFindings(report: SanitizationReport): Finding[] {
  return report.findings.filter((f) => f.blocking);
}

/** Distinct rule ids among a set of findings (for batch-by-rule affordances). */
export function distinctRuleIds(findings: Finding[]): string[] {
  return Array.from(new Set(findings.map((f) => f.ruleId)));
}
