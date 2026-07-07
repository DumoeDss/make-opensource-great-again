#!/usr/bin/env node
/**
 * HuggingFace sync — STUB (v0.1).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS A DOCUMENTED STUB. It performs NO live upload and needs NO       │
 * │  credentials. Actual HF upload + auth are an OPERATOR step, out of scope  │
 * │  for v0.1 (design doc Open Question 6: HF org + dataset repo names TBD).  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Intended flow once wired by the operator (NOT implemented here):
 *   1. Enumerate merged record files under the data/ tree on the default branch.
 *   2. Re-run the pinned shared-ruleset scan one last time (belt-and-braces).
 *   3. Assemble a versioned dataset revision (one row per record; body stays
 *      isomorphic to the source JSONL for 出口② replay).
 *   4. Push to `hf://datasets/<HF_ORG>/<HF_DATASET>` using `HF_TOKEN` from the
 *      environment (a repo secret, never committed), tagging the release with
 *      the ruleset/engine provenance version.
 *
 * On a post-publication leak, see INCIDENT-RESPONSE.md — step 1 removes the
 * offending record from the HF dataset and re-releases a new revision.
 */

const HF_ORG = process.env.HF_ORG ?? '<HF_ORG_TBD>';
const HF_DATASET = process.env.HF_DATASET ?? '<HF_DATASET_TBD>';

console.log('mosga hf-sync — STUB (no live upload performed)');
console.log(`  target (placeholder): hf://datasets/${HF_ORG}/${HF_DATASET}`);
console.log('  credentials: NOT read; HF_TOKEN handling is an operator responsibility.');
console.log('  This script intentionally uploads nothing. See the header for the intended flow.');

// Never exit non-zero solely for being a stub; it must be safe to invoke.
process.exit(0);
