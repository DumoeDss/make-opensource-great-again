import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SanitizedSessionSchema } from '@mosga/contracts';
import { describe, expect, it } from 'vitest';

import { precheckRecord } from '../index.js';

const TEMPLATE = fileURLToPath(new URL('../../../../templates/community-data-repo/', import.meta.url));
const read = (rel: string): string => readFileSync(TEMPLATE + rel, 'utf-8');

describe('community data-repo template scaffold', () => {
  it('contains the required skeleton: README, data-LICENSE, and a data/ layout', () => {
    expect(existsSync(TEMPLATE + 'README.md')).toBe(true);
    expect(existsSync(TEMPLATE + 'LICENSE-DATA')).toBe(true);
    expect(existsSync(TEMPLATE + 'data/README.md')).toBe(true);
    // The data layout matches the exporter's deterministic placement scheme.
    expect(read('data/README.md')).toContain('data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl');
  });

  it('CI workflow installs the PINNED sanitizer and scans changed records + canaries', () => {
    const wf = read('.github/workflows/scan.yml');
    expect(wf).toContain('npm ci');
    expect(wf).toContain('scripts/scan-changed.mjs');
    expect(wf).toContain('scan:canary');
    expect(wf).toContain("git diff --name-only");
    expect(wf).toContain("data/**/*.jsonl");
    // Basic YAML sanity: top-level keys present and no tab indentation.
    expect(wf).toMatch(/^name:\s*scan/m);
    expect(wf).toMatch(/^on:/m);
    expect(wf).toMatch(/^jobs:/m);
    expect(wf.includes('\t')).toBe(false);
  });

  it('pins @mosga/sanitizer + @mosga/publisher to an EXACT version (no ^/~)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@mosga/sanitizer']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@mosga/publisher']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('canary fixtures are obviously-fake, valid records that the scan logic catches', () => {
    const dir = TEMPLATE + 'tests/canary/';
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const line = readFileSync(dir + f, 'utf-8')
        .split('\n')
        .find((l) => l.trim().length > 0)!;
      // A valid SanitizedSession record...
      const parsed = JSON.parse(line) as unknown;
      expect(SanitizedSessionSchema.safeParse(parsed).success).toBe(true);
      // ...that is obviously fake...
      expect(line.toUpperCase()).toContain('CANARY');
      // ...and IS caught by the same pre-check logic the workflow invokes.
      const result = precheckRecord(line, {});
      expect(result.ok).toBe(false);
      expect(result.blockingFindings.length).toBeGreaterThan(0);
    }
  });

  it('includes a canary that plants its secret OUTSIDE message content (B1 backstop proof)', () => {
    // The meta/projectKey canary's message body is clean; only the raw-bytes
    // backstop catches it. This is the CI-level proof that B1 stays fixed.
    const line = readFileSync(TEMPLATE + 'tests/canary/meta-projectkey.jsonl', 'utf-8')
      .split('\n')
      .find((l) => l.trim().length > 0)!;
    const rec = JSON.parse(line) as { messages: Array<{ content?: string }> };
    const bodyText = rec.messages.map((m) => m.content ?? '').join('\n');
    // The secret is NOT in the message body...
    expect(bodyText).not.toMatch(/ghp_[0-9a-zA-Z]{36}|AKIA[A-Z0-9]{16}/);
    // ...yet the pre-check still refuses it (via the backstop).
    const result = precheckRecord(line, {});
    expect(result.ok).toBe(false);
    expect(result.blockingFindings.length).toBeGreaterThan(0);
  });

  it('CI scan reads the provenance sidecar and checks engine parity (M2)', () => {
    const scan = read('scripts/scan-changed.mjs');
    expect(scan).toContain('checkEngineParity');
    expect(scan).toContain('.provenance.json');
    expect(scan).toMatch(/VERSION MISMATCH/);
  });

  it('HF sync is a documented stub that performs no live upload', () => {
    const stub = read('scripts/hf-sync.mjs');
    expect(stub.toUpperCase()).toContain('STUB');
    expect(stub).toContain('no live upload');
    // The stub must not actually import an HF client or perform a network upload.
    expect(stub).not.toMatch(/fetch\(|https?:\/\/huggingface/);
  });
});
