import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { isEntrypoint, run } from '../cli.js';
import type { RunningDaemon } from '../server.js';

describe('isEntrypoint (auto-run guard)', () => {
  it('returns false when there is no argv1 (imported, not launched)', () => {
    expect(isEntrypoint('file:///whatever/cli.js', undefined)).toBe(false);
  });

  it('matches when argv1 is the same real file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mosga-cli-'));
    const real = path.join(tmp, 'cli.js');
    fs.writeFileSync(real, '// stub\n');
    try {
      const url = pathToFileURL(fs.realpathSync(real)).href;
      expect(isEntrypoint(url, real)).toBe(true);
      // A different file must NOT match.
      expect(isEntrypoint(url, path.join(tmp, 'other.js'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves argv1 through realpath before comparing (the symlinked-bin case)', () => {
    // import.meta.url is always the realpath; the launched argv1 may be a symlink
    // (the npm `mosga` bin on macOS/Linux) or otherwise non-canonical. A raw
    // compare would miss; realpath resolution must make them match. We assert at
    // least one realpath-requiring path form matches, exercising the fix even on
    // Windows where symlink creation may be unprivileged.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mosga-cli-')));
    const real = path.join(tmp, 'cli.js');
    fs.writeFileSync(real, '// stub\n');
    try {
      const url = pathToFileURL(real).href;
      let exercised = false;

      // Primary: a symlink to the real bin resolves to it (the exact prod case).
      const link = path.join(tmp, 'mosga-link.js');
      try {
        fs.symlinkSync(real, link);
        expect(isEntrypoint(url, link)).toBe(true);
        exercised = true;
      } catch {
        // Symlink creation may require privileges on Windows; try case-folding.
      }

      // Fallback (Windows, case-insensitive FS): a differently-cased path is not
      // textually equal but realpath-resolves to the on-disk casing.
      if (!exercised && process.platform === 'win32') {
        const miscased = path.join(tmp, 'CLI.JS');
        if (miscased !== real) {
          expect(isEntrypoint(url, miscased)).toBe(true);
          exercised = true;
        }
      }

      // In all cases the raw (unresolved, wrong) path must NOT match.
      expect(isEntrypoint(url, path.join(tmp, 'not-the-entry.js'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The `--no-open` flag lets the desktop shell spawn the daemon without the CLI
// launching an OS browser tab. We spy the injected opener rather than actually
// opening a browser, and bind an ephemeral port (0) to avoid clashing with a
// real daemon on 8899.
describe('mosga ui CLI', () => {
  it('--no-open starts and serves without invoking the browser opener', async () => {
    const openBrowser = vi.fn();
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await run(['ui', '--no-open', '--port', '0'], { openBrowser, stdout: () => {}, stderr: () => {} });
      expect(daemon).toBeDefined();
      expect(openBrowser).not.toHaveBeenCalled();
      // Still binds loopback and serves as usual.
      const res = await fetch(`${daemon!.url}/api/health`);
      expect(res.status).toBe(200);
      expect(daemon!.host).toBe('127.0.0.1');
    } finally {
      await daemon?.close();
    }
  });

  it('default start opens the browser at /ui', async () => {
    const openBrowser = vi.fn();
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await run(['ui', '--port', '0'], { openBrowser, stdout: () => {}, stderr: () => {} });
      expect(daemon).toBeDefined();
      expect(openBrowser).toHaveBeenCalledTimes(1);
      expect(openBrowser).toHaveBeenCalledWith(`${daemon!.url}/ui/`);
    } finally {
      await daemon?.close();
    }
  });
});
