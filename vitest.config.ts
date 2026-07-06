import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Tests run against SOURCE, not the built dist, so a test never needs a prior
// build. The aliases map each `@mosga/<pkg>` bare import to the package's src/,
// resolved to an absolute filesystem path relative to this config (not a
// root-absolute string) so the mapping is portable across checkout locations.
const src = (pkg: string): string => fileURLToPath(new URL(`./packages/${pkg}/src`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mosga/contracts': src('contracts'),
      '@mosga/session-readers': src('session-readers'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/__tests__/**/*.{test,spec}.ts',
      'packages/*/src/**/*.{test,spec}.ts',
    ],
    environment: 'node',
  },
});
