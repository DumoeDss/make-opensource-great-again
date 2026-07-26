#!/usr/bin/env node
/**
 * `mosga-publish` — local diagnostic for the mandatory publication pre-check.
 *
 *   mosga-publish precheck <record>   re-scan exact bytes; exit non-zero on a blocking finding
 */
import { readFileSync } from 'node:fs';

import { loadTrustedCustomRules } from './config.js';
import { precheckRecord } from './precheck.js';

interface Args {
  command: string;
  input?: string;
  customRules?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--custom-rules') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--custom-rules requires a path');
      args.customRules = value;
    }
    else if (a.startsWith('-')) throw new Error(`unknown option "${a}"`);
    else if (!args.command) args.command = a;
    else if (!args.input) args.input = a;
    else throw new Error(`unexpected argument "${a}"`);
  }
  return args;
}

const HELP = `mosga-publish — mandatory publication pre-check diagnostic

Usage:
  mosga-publish precheck <record.jsonl|session.json> [--custom-rules <path>]

The pre-check re-scans the exact bytes about to be published with the shared
@mosga/sanitizer ruleset and HARD-REFUSES (non-zero exit) on any blocking
finding. This command does not prepare a repository, run Git or gh, or deliver
a contribution.`;

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    process.exitCode = 0;
    return;
  }
  if (!args.command) {
    process.stdout.write(`${HELP}\n`);
    process.exitCode = 2;
    return;
  }
  if (!args.input) {
    process.stderr.write('error: missing input file\n');
    process.exitCode = 2;
    return;
  }
  const customRules = loadTrustedCustomRules(args.customRules);

  try {
    if (args.command === 'precheck') {
      const raw = readFileSync(args.input, 'utf-8');
      const result = precheckRecord(raw, { customRules });
      process.stdout.write(
        `engine: @mosga/sanitizer@${result.engine.sanitizerPackageVersion} ` +
          `ruleset=${result.engine.rulesetVersion} gitleaks=${result.engine.gitleaksVersion}\n`,
      );
      if (result.ok) {
        process.stdout.write('pre-check PASSED: 0 blocking findings.\n');
        return;
      }
      process.stderr.write(`pre-check REFUSED: ${result.blockingFindings.length} blocking finding(s):\n`);
      for (const f of result.blockingFindings) {
        process.stderr.write(`  - ${f.ruleId} @ ${f.location.field} (${f.matchPreview})\n`);
      }
      process.exitCode = 1;
      return;
    }

    process.stderr.write(`unknown command "${args.command}"\n${HELP}\n`);
    process.exitCode = 2;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

main();
