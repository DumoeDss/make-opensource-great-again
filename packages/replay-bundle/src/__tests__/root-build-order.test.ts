import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('documented root build order', () => {
  it('keeps replay-bundle between sanitizer and ui in scripts and README', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: { build: string; typecheck: string } };
    const workspaceSequence =
      '@mosga/sanitizer && npm run build -w @mosga/replay-bundle && npm run build -w @mosga/ui';
    const typecheckSequence =
      '@mosga/sanitizer && npm run typecheck -w @mosga/replay-bundle && npm run typecheck -w @mosga/ui';
    expect(packageJson.scripts.build).toContain(workspaceSequence);
    expect(packageJson.scripts.typecheck).toContain(typecheckSequence);

    const readme = readFileSync(
      path.join(repositoryRoot, 'README.md'),
      'utf8',
    );
    expect(readme).toContain(
      'contracts → readers → sanitizer → replay-bundle → ui → daemon → publisher → direct-submit',
    );
  });
});
