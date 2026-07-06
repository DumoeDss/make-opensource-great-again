import type { Finding, NonTextItem, SanitizationReport } from '../api/types';

/** Hand-crafted fixture report/finding builders for component tests. */

export function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    layer: 'secrets',
    ruleId: 'aws-access-token',
    location: {
      scope: 'message',
      messageIndex: 0,
      messageUuid: 'm0',
      field: 'content',
      span: { start: 0, end: 5 },
    },
    matchPreview: 'AK…34',
    replacementSuggestion: '<SECRET:aws-access-token>',
    disposition: 'pending',
    blocking: true,
    ...over,
  };
}

export function makeNonText(over: Partial<NonTextItem> = {}): NonTextItem {
  return { messageIndex: 1, messageUuid: 'm1', blockTypes: ['image'], disposition: 'pending', ...over };
}

/** Assemble a report from findings + non-text items with a recomputed gate. */
export function makeReport(findings: Finding[], nonText: NonTextItem[] = []): SanitizationReport {
  const blocking = findings.filter((f) => f.blocking);
  const blockingPending = blocking.filter((f) => f.disposition === 'pending').length;
  const nonTextPending = nonText.filter((n) => n.disposition === 'pending').length;
  const normalization = findings.filter((f) => f.layer === 'normalization');
  const byCategory: Record<string, number> = {};
  for (const f of normalization) {
    const k = f.category ?? 'other';
    byCategory[k] = (byCategory[k] ?? 0) + 1;
  }
  return {
    reportVersion: '0.1.0',
    sanitizationRulesetVersion: 'gitleaks@test+mosga-l3@0.1.0+custom@none',
    sessionId: 'sess-test',
    generatedAt: '2026-07-07T00:00:00.000Z',
    findings,
    layerSummary: {
      secrets: {
        total: findings.filter((f) => f.layer === 'secrets').length,
        pending: findings.filter((f) => f.layer === 'secrets' && f.disposition === 'pending').length,
      },
      custom: {
        total: findings.filter((f) => f.layer === 'custom').length,
        pending: findings.filter((f) => f.layer === 'custom' && f.disposition === 'pending').length,
      },
      normalization: { total: normalization.length, byCategory },
    },
    nonTextItems: nonText,
    gate: {
      blockingTotal: blocking.length,
      blockingPending,
      nonTextPending,
      unlocked: blockingPending === 0 && nonTextPending === 0,
    },
  };
}
