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

  it('ships locked, self-contained snapshots of the coordinated @mosga engine packages', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read('package-lock.json')) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    };
    const packages = ['contracts', 'session-readers', 'sanitizer', 'publisher'];

    expect(lock.lockfileVersion).toBe(3);
    for (const name of packages) {
      const tarball = `vendor/mosga-${name}-0.1.0.tgz`;
      const dependencyName = `@mosga/${name}`;
      const lockedPackage = lock.packages[`node_modules/${dependencyName}`];

      expect(pkg.dependencies[dependencyName]).toBe(`file:${tarball}`);
      expect(existsSync(TEMPLATE + tarball)).toBe(true);
      expect(lockedPackage).toMatchObject({
        version: '0.1.0',
        resolved: `file:${tarball}`,
      });
      expect(lockedPackage.integrity).toMatch(/^sha512-/);
    }
  });

  it('scans every vendored archive for real Windows users and private workspace roots', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const scanner = read('scripts/validate-vendor.mjs');

    expect(pkg.scripts['check:compat']).toContain('validate:vendor');
    expect(scanner).toContain('gunzipSync');
    expect(scanner).toContain('WINDOWS_USERS_ROOT');
    expect(scanner).toContain('KNOWN_PRIVATE_WORKSPACE');
    expect(scanner).not.toContain('ExampleUser');
    expect(scanner).not.toContain('Sayo');
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
