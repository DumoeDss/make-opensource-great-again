#!/usr/bin/env node
/**
 * `mosga-submit` — headless 出口② direct-submit for a gate-unlocked, stamped
 * SanitizedSession. Estimates cost, or submits behind the informed-consent gate
 * and the pre-send raw-bytes backstop. The provider key is read SERVER-SIDE from
 * env / a trusted local key config — never a CLI arg or the session file.
 *
 *   mosga-submit providers                              list selectable providers (key-free)
 *   mosga-submit estimate <session.json> --provider <id> --model <m> [--mode single-shot|turn-by-turn]
 *   mosga-submit submit   <session.json> --provider <id> --model <m> [--mode ...]
 *                         --ack-tos --ack-retention [--key-config <path>]
 *
 * `submit` requires BOTH acknowledgment flags; missing/false refuses (nothing sent).
 */
import { readFileSync } from 'node:fs';

import { type SanitizedSession } from '@mosga/contracts';
import { compileRuleset } from '@mosga/sanitizer';

import { computeContentHash } from './consent.js';
import { estimate } from './estimate.js';
import { resolveProviderKey } from './keys.js';
import { listProviders, resolveProvider } from './providers.js';
import { submit } from './submit.js';
import { fetchTransport } from './transport.js';
import { resolveMetaVersions } from './versions.js';

interface Args {
  command: string;
  input?: string;
  provider?: string;
  model?: string;
  mode: 'single-shot' | 'turn-by-turn';
  ackTos: boolean;
  ackRetention: boolean;
  keyConfig?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', mode: 'single-shot', ackTos: false, ackRetention: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--mode') args.mode = argv[++i] === 'turn-by-turn' ? 'turn-by-turn' : 'single-shot';
    else if (a === '--ack-tos') args.ackTos = true;
    else if (a === '--ack-retention') args.ackRetention = true;
    else if (a === '--key-config') args.keyConfig = argv[++i];
    else if (!args.command) args.command = a;
    else if (!args.input) args.input = a;
  }
  return args;
}

const HELP = `mosga-submit — 出口② direct-submit (estimate / submit)

Usage:
  mosga-submit providers
  mosga-submit estimate <session.json> --provider <id> --model <m> [--mode single-shot|turn-by-turn]
  mosga-submit submit   <session.json> --provider <id> --model <m> [--mode ...] --ack-tos --ack-retention [--key-config <path>]

The key is read server-side from MOSGA_PROVIDER_KEY_<ID> / MOSGA_PROVIDER_KEY or
the --key-config JSON; it never appears in any output. submit requires BOTH
--ack-tos and --ack-retention, and runs the pre-send raw-bytes backstop.`;

function readSession(path: string): SanitizedSession {
  return JSON.parse(readFileSync(path, 'utf-8')) as SanitizedSession;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (args.command === 'providers') {
    process.stdout.write(`${JSON.stringify(listProviders(), null, 2)}\n`);
    return;
  }

  if (!args.input || !args.provider || !args.model) {
    process.stderr.write('error: <session.json>, --provider, and --model are required\n');
    process.exitCode = 2;
    return;
  }
  const session = readSession(args.input);
  const target = resolveProvider(args.provider);
  if (!target) {
    process.stderr.write(`error: unknown provider "${args.provider}"\n`);
    process.exitCode = 2;
    return;
  }
  const versions = resolveMetaVersions();

  if (args.command === 'estimate') {
    const est = estimate(session, args.mode, { metaVersions: versions });
    process.stdout.write(`${JSON.stringify(est, null, 2)}\n`);
    return;
  }

  if (args.command === 'submit') {
    const est = estimate(session, args.mode, { metaVersions: versions });
    const consent = {
      consentVersion: '0.2.0',
      tosRiskAcknowledged: args.ackTos,
      fullRetentionAcknowledged: args.ackRetention,
      targetProviderId: target.id,
      targetModel: args.model,
      replayMode: args.mode,
      estimatedTokens: est.totalTokens,
      contentHash: computeContentHash(session),
      confirmedAt: new Date().toISOString(),
    };
    const apiKey = resolveProviderKey(target.id, { keyConfigPath: args.keyConfig });
    try {
      const receipt = await submit({
        session,
        target,
        model: args.model,
        consent,
        ruleset: compileRuleset(),
        apiKey,
        transport: fetchTransport,
        versions,
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } catch (err) {
      process.stderr.write(`refused: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`error: unknown command "${args.command}"\n`);
  process.exitCode = 2;
}

void main();
