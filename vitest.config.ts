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
      '@mosga/sanitizer': src('sanitizer'),
      '@mosga/direct-submit': src('direct-submit'),
      '@mosga/publisher': src('publisher'),
      // `@` → @mosga/ui's src, matching the ported omnicross primitives' `@/...`
      // imports. No other package imports `@/`, so this mapping is inert for them.
      '@': fileURLToPath(new URL('./packages/ui/src', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/*/src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
    ],
    // Default to node; UI component tests opt into jsdom per-file via a
    // `// @vitest-environment jsdom` header comment.
    environment: 'node',
  },
});
