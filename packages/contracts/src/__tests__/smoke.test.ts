import { describe, expect, it } from 'vitest';

import { SanitizedSessionSchema } from '../index.js';

// Skeleton smoke test: the package resolves, imports, and its entry exports a
// usable schema. Proves resolution → transpile → test is wired end to end.
describe('@mosga/contracts smoke', () => {
  it('exports SanitizedSessionSchema', () => {
    expect(typeof SanitizedSessionSchema.parse).toBe('function');
  });
});
