import { type EngineInfo, type ProvenanceStamp } from './provenance.js';

export interface ParityResult {
  /** True when the record's stamped engine matches the scanning engine. */
  ok: boolean;
  /** Human-readable descriptions of each field that diverged. */
  mismatches: string[];
}

type ProvenancePins = Pick<
  ProvenanceStamp,
  'sanitizerPackageVersion' | 'sanitizationRulesetVersion' | 'gitleaksVersion'
>;

/**
 * Split a composite `rulesetVersion` into its ADDITIVE segments. The format is
 * `gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>` (see `compileRuleset`). The
 * `custom@` segment is deliberately additive (design D3): the community CI
 * applies its own committed custom rules while a contributor stamps
 * `custom@none`, so the two legitimately differ. Only the BASELINE prefix
 * (`gitleaks@<tag>+mosga-l3@<ver>`) must match for the engines to agree on the
 * shared ruleset.
 */
function splitRulesetVersion(version: string): { baseline: string; custom: string | null } {
  const marker = '+custom@';
  const idx = version.indexOf(marker);
  if (idx === -1) return { baseline: version, custom: null };
  return { baseline: version.slice(0, idx), custom: version.slice(idx + marker.length) };
}

/**
 * Verify a record's committed provenance stamp against the engine actually doing
 * the scan (review findings M2 / M2b). The m3 invariant promises that a local/CI
 * engine mismatch is a VISIBLE failure, never a silent divergence — but pinning
 * the version alone does nothing unless something compares it. The community CI
 * runs this over each record's `*.provenance.json` sidecar and fails on any
 * mismatch.
 *
 * Comparison rules:
 * - `sanitizerPackageVersion` and `gitleaksVersion` — the ENGINE PINS — must match
 *   exactly.
 * - `rulesetVersion` — only the BASELINE segment (`gitleaks@…+mosga-l3@…`) must
 *   match. The additive `custom@…` segment is ALLOWED to differ (a contributor's
 *   `custom@none` vs a CI with community custom rules enabled: `custom@<hash>`),
 *   because community custom rules only ever catch MORE (D3) — so a differing
 *   `custom@` is not a divergence that could let a leak through. Comparing the
 *   whole string here would fail EVERY legitimate contribution the moment a
 *   community enables custom rules (finding M2b).
 *
 * A missing stamp (no sidecar) fails closed: the exporter always writes a
 * sidecar, so an absent one means tampering or a non-conforming record.
 */
export function checkEngineParity(
  provenance: ProvenancePins | null | undefined,
  engine: EngineInfo,
): ParityResult {
  if (!provenance) {
    return {
      ok: false,
      mismatches: [
        'missing provenance sidecar: every exported record must ship a *.provenance.json; an absent one means tampering or a non-conforming record',
      ],
    };
  }

  const mismatches: string[] = [];
  if (provenance.sanitizerPackageVersion !== engine.sanitizerPackageVersion) {
    mismatches.push(
      `sanitizerPackageVersion: record stamped "${provenance.sanitizerPackageVersion}" but the CI engine is "${engine.sanitizerPackageVersion}"`,
    );
  }
  if (provenance.gitleaksVersion !== engine.gitleaksVersion) {
    mismatches.push(
      `gitleaksVersion: record stamped "${provenance.gitleaksVersion}" but the CI engine is "${engine.gitleaksVersion}"`,
    );
  }

  // Only the baseline ruleset segment must match; the additive custom@ segment may
  // differ (community CI enables custom rules → custom@<hash> vs custom@none).
  const stamped = splitRulesetVersion(provenance.sanitizationRulesetVersion);
  const ci = splitRulesetVersion(engine.rulesetVersion);
  if (stamped.baseline !== ci.baseline) {
    mismatches.push(
      `ruleset baseline: record stamped "${stamped.baseline}" but the CI engine baseline is "${ci.baseline}"`,
    );
  }

  return { ok: mismatches.length === 0, mismatches };
}
