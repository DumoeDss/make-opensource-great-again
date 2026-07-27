import { describe, expect, it } from 'vitest';

import {
  ReplayFindingLocationSchema,
  ReplaySanitizationReportSchema,
  ReplayScanResultSchema,
} from '../index.js';

function fakeReport() {
  return {
    schemaVersion: '1.0.0' as const,
    reportVersion: '1.0.0' as const,
    draftId: 'draft-1',
    draftContentHash: `sha256:${'a'.repeat(64)}`,
    sanitizationRulesetVersion: 'rules-1',
    generatedAt: '2026-07-27T00:00:00.000Z',
    findings: [
      {
        id: 'finding-1',
        layer: 'secrets' as const,
        ruleId: 'fake-secret',
        category: null,
        location: {
          kind: 'native' as const,
          fileId: 'transcript',
          rowOrdinal: 4,
          jsonPointer: '/payload/content/0/text',
          span: { start: 1, end: 4 },
        },
        matchPreview: 'f…e',
        matchHash: `sha256:${'b'.repeat(64)}`,
        replacementSuggestion: '<REDACTED>',
        disposition: 'pending' as const,
        blocking: true,
      },
    ],
    opaqueItems: [
      {
        id: 'opaque-1',
        location: {
          kind: 'native' as const,
          fileId: 'transcript',
          rowOrdinal: 5,
          jsonPointer: '/payload/content/1',
        },
        blockType: 'image',
        matchPreview: '[opaque:image]',
        disposition: 'pending' as const,
        replacement: null,
      },
    ],
    layerSummary: {
      secrets: { total: 1, pending: 1 },
      custom: { total: 0, pending: 0 },
      normalization: { total: 0, byCategory: {} },
      guard: { total: 0, pending: 0 },
    },
    gate: {
      schemaVersion: '1.0.0' as const,
      blockingTotal: 1,
      blockingPending: 1,
      opaquePending: 1,
      unlocked: false,
    },
  };
}

describe('Replay sanitizer schemas', () => {
  it('validates versioned artifact-aware reports and gates', () => {
    const report = fakeReport();
    expect(ReplaySanitizationReportSchema.parse(report)).toEqual(report);
    expect(
      ReplayFindingLocationSchema.parse(report.findings[0]!.location),
    ).toEqual(report.findings[0]!.location);
  });

  it('validates discriminated scan results and rejects unknown keys', () => {
    expect(
      ReplayScanResultSchema.parse({ ok: true, report: fakeReport() }).ok,
    ).toBe(true);
    expect(
      ReplayScanResultSchema.safeParse({
        ok: false,
        error: {
          schemaVersion: '1.0.0',
          code: 'invalid-draft',
          message: 'The replay draft is invalid.',
          originalPath: 'C:\\private\\session.jsonl',
        },
      }).success,
    ).toBe(false);
  });

  it('does not change the legacy report version shape', async () => {
    const { SanitizationReportSchema } = await import('../index.js');
    expect(
      SanitizationReportSchema.safeParse({
        ...fakeReport(),
        sessionId: 'legacy-session',
      }).success,
    ).toBe(false);
  });
});
