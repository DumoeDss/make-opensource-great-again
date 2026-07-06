import { describe, expect, it } from 'vitest';

import { SanitizationReportSchema, compileRuleset } from '../index.js';

// Skeleton smoke test: the package resolves, imports, and its entry exports a
// usable schema + the ingestion entrypoint. Proves resolution → transpile →
// test is wired end to end so the root vitest runner picks the package up.
describe('@mosga/sanitizer smoke', () => {
  it('exports the report schema and can compile the vendored ruleset', () => {
    expect(typeof SanitizationReportSchema.parse).toBe('function');
    const rs = compileRuleset({ generatedAt: '2026-07-07T00:00:00.000Z' });
    expect(rs.rules.length).toBeGreaterThan(100);
    expect(rs.gitleaksVersion).toBe('v8.18.4');
  });
});
