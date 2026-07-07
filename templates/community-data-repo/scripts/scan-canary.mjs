#!/usr/bin/env node
/**
 * Gate self-test. Every fixture under `tests/canary/` carries an obviously-fake,
 * non-functional planted secret and MUST be caught by the pinned scan. If any
 * canary passes clean, the scan gate is broken — fail the build loudly. A green
 * canary run is the living proof the verification defense is alive on this exact
 * engine version.
 *
 * Coverage includes secrets planted in message content (github-pat, aws-key) AND
 * in fields the structure-aware scanner never visits — `meta.toolVersion` /
 * `session.projectKey` (meta-projectkey) — which only the raw-bytes backstop
 * catches (review finding B1). If that canary ever passes, the backstop regressed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { precheckRecord } from '@mosga/publisher';

const dir = 'tests/canary';
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));

if (files.length === 0) {
  console.error(`Gate self-test found no canary fixtures in ${dir}/ — refusing to run blind.`);
  process.exit(1);
}

let broken = false;
for (const file of files) {
  const line = readFileSync(join(dir, file), 'utf-8')
    .split('\n')
    .find((l) => l.trim().length > 0);
  const result = precheckRecord(line, {});
  if (result.ok) {
    broken = true;
    console.error(`GATE BROKEN: canary ${file} was NOT caught (0 blocking findings).`);
  } else {
    console.log(`canary ${file}: caught (${result.blockingFindings.length} blocking finding(s)) ✔`);
  }
}

if (broken) {
  console.error('\nThe scan gate failed its self-test. Do not trust CI results until fixed.');
  process.exit(1);
}
console.log('\nGate self-test passed: every canary was caught.');
process.exit(0);
