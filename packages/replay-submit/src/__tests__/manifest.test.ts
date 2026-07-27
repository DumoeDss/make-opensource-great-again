/**
 * Terminal-manifest renderer tests: determinism, content, no-enrichment.
 */
import { describe, expect, it } from 'vitest';

import { renderTerminalManifest } from '../manifest.js';
import type { RenderTerminalManifestInput } from '../manifest.js';
import {
  sealedBundle,
  bundleContentHash,
  validConsent,
} from './fixtures.js';
import { validateReplayBundle } from '@mosga/replay-bundle';

function makeManifestInput(): RenderTerminalManifestInput {
  const bundle = sealedBundle();
  const payload = validateReplayBundle(bundle);
  return {
    seed: payload.terminalManifestSeed,
    omissions: payload.omissions,
    humanReviewPassed: payload.review.humanReviewPassed,
    bundleContentHash: bundleContentHash(bundle),
    replayCliVersion: '1.2.3',
    consent: validConsent(bundle),
  };
}

describe('renderTerminalManifest determinism', () => {
  it('produces byte-identical output for identical inputs', () => {
    const input = makeManifestInput();
    const a = renderTerminalManifest(input);
    const b = renderTerminalManifest(input);
    expect(a).toBe(b);
  });

  it('produces byte-identical output even when object key order differs', () => {
    const input = makeManifestInput();
    const a = renderTerminalManifest(input);
    // Reconstruct the same data with different key insertion order.
    const shuffled: RenderTerminalManifestInput = {
      consent: input.consent,
      replayCliVersion: input.replayCliVersion,
      bundleContentHash: input.bundleContentHash,
      humanReviewPassed: input.humanReviewPassed,
      omissions: input.omissions,
      seed: input.seed,
    };
    const b = renderTerminalManifest(shuffled);
    expect(a).toBe(b);
  });
});

describe('renderTerminalManifest content', () => {
  const manifest = renderTerminalManifest(makeManifestInput());

  it('starts with an ACK-only preamble', () => {
    expect(manifest.startsWith('Reply with ACK only')).toBe(true);
  });

  it('wraps the JSON in mosga-session-context tags', () => {
    expect(manifest).toContain('<mosga-session-context>');
    expect(manifest).toContain('</mosga-session-context>');
  });

  it('contains the runtime-observed replayCliVersion', () => {
    expect(manifest).toContain('"replayCliVersion":"1.2.3"');
  });

  it('contains the bundleContentHash in the sanitization section', () => {
    const input = makeManifestInput();
    const rendered = renderTerminalManifest(input);
    expect(rendered).toContain(input.bundleContentHash);
  });

  it('contains humanReviewPassed', () => {
    expect(manifest).toContain('"humanReviewPassed":true');
  });

  it('discloses reviewed omissions', () => {
    const input = makeManifestInput();
    const rendered = renderTerminalManifest(input);
    // The fixture has one omission with disclosure text.
    for (const omission of input.omissions) {
      expect(rendered).toContain(omission.disclosure);
      expect(rendered).toContain(omission.category);
    }
  });

  it('contains the consent acknowledgment subset', () => {
    expect(manifest).toContain('"runtimeContextAcknowledged":true');
    expect(manifest).toContain('"tosRiskAcknowledged":true');
  });

  it('uses LF line endings (no CRLF)', () => {
    expect(manifest).not.toContain('\r');
  });
});

describe('renderTerminalManifest no-enrichment', () => {
  it('does not include data not present in the inputs', () => {
    const input = makeManifestInput();
    const rendered = renderTerminalManifest(input);
    // The renderer must not add the raw session path, upstream key, or any
    // content not in its explicit inputs.
    expect(rendered).not.toContain('upstreamApiKey');
    expect(rendered).not.toContain('routeToken');
    expect(rendered).not.toContain('workspace');
  });
});
