#!/usr/bin/env node
/**
 * Re-scan changed dataset record files with the PINNED @mosga/sanitizer engine,
 * via @mosga/publisher's `precheckRecord` — the identical logic the contributor
 * ran locally. Exits non-zero on ANY surviving blocking finding, so a leaked
 * secret can never merge.
 *
 * Usage: node scripts/scan-changed.mjs <record.jsonl> [<record.jsonl> ...]
 * (The CI workflow computes the changed record files under data/ and passes them.)
 *
 * Community-wide custom rules (Layer 2), if the repo commits a
 * `sanitizer.custom-rules.json`, are applied additively — they only ever catch
 * MORE. Contributor-private custom rules stay on the contributor's machine.
 */
import { existsSync, readFileSync } from 'node:fs';

import { checkEngineParity, precheckRecord } from '@mosga/publisher';

const files = process.argv.slice(2).filter((f) => f.endsWith('.jsonl'));

const customRules = existsSync('sanitizer.custom-rules.json')
  ? JSON.parse(readFileSync('sanitizer.custom-rules.json', 'utf-8'))
  : [];

if (files.length === 0) {
  console.log('No changed record files to scan.');
  process.exit(0);
}

let failed = false;
for (const file of files) {
  const lines = readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const result = precheckRecord(line, { customRules });
    console.log(
      `[${file}] engine @mosga/sanitizer@${result.engine.sanitizerPackageVersion} ` +
        `ruleset=${result.engine.rulesetVersion} gitleaks=${result.engine.gitleaksVersion}`,
    );
    if (result.ok) {
      console.log(`  OK — 0 blocking findings`);
    } else {
      failed = true;
      console.error(`  BLOCKED — ${result.blockingFindings.length} blocking finding(s):`);
      for (const f of result.blockingFindings) {
        console.error(`    - ${f.ruleId} @ ${f.location.field}`);
      }
    }

    // Version-parity check (finding M2): compare the record's committed provenance
    // sidecar to the engine CI actually scanned with. A mismatch means the local
    // and CI verdicts came from different engines — a VISIBLE failure, per m3, not
    // a silent divergence. This also brings the sidecar inside the scan boundary
    // (finding m1).
    const sidecar = file.replace(/\.jsonl$/, '.provenance.json');
    if (existsSync(sidecar)) {
      const provenance = JSON.parse(readFileSync(sidecar, 'utf-8'));
      const parity = checkEngineParity(provenance, result.engine);
      if (!parity.ok) {
        failed = true;
        console.error(`  VERSION MISMATCH — ${sidecar} does not match the CI-pinned engine:`);
        for (const m of parity.mismatches) console.error(`    - ${m}`);
      }
    } else {
      // Fail closed: the exporter ALWAYS writes a sidecar next to each record, so
      // an absent one means tampering or a non-conforming contribution. Skipping
      // the parity check here would let a record scanned by an unknown engine
      // merge silently — refuse instead.
      failed = true;
      console.error(
        `  MISSING PROVENANCE — ${sidecar} not found; every exported record must ship a *.provenance.json sidecar. Refusing.`,
      );
    }
  }
}

if (failed) {
  console.error(
    '\nRefusing to merge: at least one record failed the shared-ruleset re-scan, engine version-parity check, or is missing its provenance sidecar.',
  );
  process.exit(1);
}
console.log('\nAll changed records passed the shared-ruleset re-scan.');
process.exit(0);
