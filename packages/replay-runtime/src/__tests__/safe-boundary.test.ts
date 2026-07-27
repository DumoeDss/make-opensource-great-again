import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RuntimeFault, safeFailure } from '../errors.js';
import type {
  ReplayRuntimeErrorCode,
  ReplayRuntimeStage,
} from '../types.js';

const errorCodes: readonly ReplayRuntimeErrorCode[] = [
  'bundle-invalid',
  'runtime-policy-unsupported',
  'source-cli-unsupported',
  'cli-not-found',
  'cli-probe-failed',
  'cli-version-unsupported',
  'cli-capability-unsupported',
  'session-layout-unsupported',
  'workspace-create-failed',
  'workspace-materialize-failed',
  'instruction-stage-failed',
  'skill-root-invalid',
  'skill-exposure-failed',
  'prepared-replay-consumed',
  'route-binding-invalid',
  'terminal-input-invalid',
  'process-spawn-failed',
  'process-exit-failed',
  'process-output-limit',
  'cancelled',
  'timed-out',
  'cleanup-failed',
];
const stages: readonly ReplayRuntimeStage[] = [
  'validate',
  'probe',
  'materialize',
  'launch',
  'run',
  'terminate',
  'cleanup',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === '__tests__' ||
      entry.name === 'fixtures' ||
      entry.name === 'dist'
    ) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(candidate)));
    else if (entry.name.endsWith('.ts')) output.push(candidate);
  }
  return output;
}

describe('disclosure-safe closed outcomes', () => {
  it('represents every documented code and stage with exactly five safe fields', () => {
    for (const [index, code] of errorCodes.entries()) {
      const stage = stages[index % stages.length]!;
      const result = safeFailure(
        new RuntimeFault(code, stage, 'codex', '0.101.8'),
        'complete',
      );
      expect(Object.keys(result).sort()).toEqual([
        'cleanup',
        'code',
        'replayCliVersion',
        'sourceCli',
        'stage',
      ]);
      expect(result).toEqual({
        code,
        stage,
        sourceCli: 'codex',
        replayCliVersion: '0.101.8',
        cleanup: 'complete',
      });
      expect(JSON.stringify(result)).not.toMatch(
        /prompt-canary|route-token|provider-key|native-body|skill-body|stderr/,
      );
    }
    expect(new Set(errorCodes).size).toBe(22);
    expect(new Set(stages).size).toBe(7);
  });

  it('has no sanitizer, provider transport, proxy server, or reconstructed-submit imports', async () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const imports: string[] = [];
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, 'utf8');
      imports.push(
        ...[...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
          (match) => match[1]!,
        ),
      );
    }
    expect(imports).not.toContain('@mosga/sanitizer');
    expect(imports).not.toContain('@mosga/direct-submit');
    expect(imports).not.toContain('node:http');
    expect(imports).not.toContain('node:https');
    expect(imports).not.toContain('node:net');
    expect(imports.some((value) => /proxy|transport|credential/i.test(value))).toBe(
      false,
    );
  });
});
