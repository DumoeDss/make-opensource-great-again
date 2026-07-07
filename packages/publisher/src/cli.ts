#!/usr/bin/env node
/**
 * `mosga-publish` — export a stamped SanitizedSession, run the mandatory local
 * pre-check, and prepare a PR contribution.
 *
 *   mosga-publish precheck <record>            re-scan bytes; exit non-zero on any blocking finding
 *   mosga-publish export   <session> --repo D  export the record + provenance into repo dir D
 *   mosga-publish prepare  <session> --repo D  plan a PR (pre-check gated); --stage to commit locally
 *
 * Common flags:
 *   --custom-rules <path>   TRUSTED local custom-rules JSON (never artifact-embedded)
 *   --stage                 (prepare) also create the branch + commit in the repo
 */
import { readFileSync } from 'node:fs';

import { type SanitizedSession } from '@mosga/contracts';

import { loadTrustedCustomRules } from './config.js';
import { exportSession } from './export.js';
import { PublishRefusedError, precheckRecord } from './precheck.js';
import { planContribution, stageContribution } from './pr.js';

interface Args {
  command: string;
  input?: string;
  repo?: string;
  customRules?: string;
  stage: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', stage: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--stage') args.stage = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--custom-rules') args.customRules = argv[++i];
    else if (!args.command) args.command = a;
    else if (!args.input) args.input = a;
  }
  return args;
}

const HELP = `mosga-publish — export + mandatory pre-check + PR prep

Usage:
  mosga-publish precheck <record.jsonl|session.json> [--custom-rules <path>]
  mosga-publish export   <session.json> --repo <dir> [--custom-rules <path>]
  mosga-publish prepare  <session.json> --repo <dir> [--custom-rules <path>] [--stage]

The pre-check re-scans the exact bytes about to be published with the shared
@mosga/sanitizer ruleset and HARD-REFUSES (non-zero exit) on any blocking
finding. No output file or PR is produced when it refuses.`;

function readSession(path: string): SanitizedSession {
  return JSON.parse(readFileSync(path, 'utf-8')) as SanitizedSession;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${HELP}\n`);
    process.exitCode = args.command ? 0 : 2;
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

    if (args.command === 'export') {
      if (!args.repo) throw new Error('export requires --repo <dir>');
      const session = readSession(args.input);
      const record = exportSession(session);
      // Gate the write behind the pre-check (defense-in-depth).
      const result = precheckRecord(record.jsonl, { customRules });
      if (!result.ok) throw new PublishRefusedError(result.blockingFindings, result.engine);
      const plan = planContribution(session, { targetRepo: args.repo, customRules });
      stageContribution(plan, { targetRepo: args.repo, customRules });
      process.stdout.write(`wrote ${plan.recordPath} (+ provenance) into ${args.repo}\n`);
      return;
    }

    if (args.command === 'prepare') {
      if (!args.repo) throw new Error('prepare requires --repo <dir>');
      const session = readSession(args.input);
      const plan = planContribution(session, { targetRepo: args.repo, customRules });
      process.stdout.write(`branch: ${plan.branch}\n`);
      process.stdout.write(`gh available: ${plan.ghAvailable ? 'yes' : 'no'}\n`);
      if (args.stage) {
        const staged = stageContribution(plan, { targetRepo: args.repo, customRules });
        process.stdout.write(`staged commit: ${staged.committed ? 'ok' : 'FAILED'}\n`);
      }
      process.stdout.write('\nManual path (run inside the target repo):\n');
      for (const cmd of plan.commands) process.stdout.write(`  ${cmd}\n`);
      return;
    }

    process.stderr.write(`unknown command "${args.command}"\n${HELP}\n`);
    process.exitCode = 2;
  } catch (err) {
    if (err instanceof PublishRefusedError) {
      process.stderr.write(`${err.message}\n`);
      for (const f of err.blockingFindings) {
        process.stderr.write(`  - ${f.ruleId} @ ${f.location.field}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

main();
