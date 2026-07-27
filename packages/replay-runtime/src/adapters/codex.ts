import path from 'node:path';

import type {
  AdapterPaths,
  CapabilityProfile,
  RuntimeAdapter,
} from './types.js';
import type { ValidatedReplayInput } from '../validated.js';

function versionMatches(version: string): boolean {
  const match = /^0\.101\.(\d+)$/.exec(version);
  return match !== null && Number(match[1]) <= 99;
}

export const CODEX_PROFILE: CapabilityProfile = Object.freeze({
  id: 'codex-0.101-exec-resume-responses-v1',
  sourceCli: 'codex',
  sourceFormat: 'codex-jsonl',
  wireProtocol: 'openai-responses',
  probeCommands: Object.freeze([
    Object.freeze({ id: 'version', argv: Object.freeze(['--version']) }),
    Object.freeze({ id: 'help', argv: Object.freeze(['--help']) }),
    Object.freeze({ id: 'exec-help', argv: Object.freeze(['exec', '--help']) }),
  ]),
  versionMatches,
  requiredMarkers: Object.freeze([
    'exec',
    'resume',
    'stdin',
    'model_provider',
    'base_url_env',
    'env_key',
    'wire_api',
    'responses',
    'codex_home',
  ]),
  storageLayoutId: 'codex-rollout-jsonl-v1',
  invocationId: 'codex-exec-resume-stdin-v1',
  stdinSupported: true,
  isolatedHomeSupported: true,
  deterministicCwdSupported: true,
  routeEnvironmentNames: Object.freeze([
    'MOSGA_ROUTE_BASE_URL',
    'MOSGA_ROUTE_TOKEN',
    'MOSGA_CLI_MODEL',
  ]),
  telemetryEnvironment: Object.freeze({
    CODEX_DISABLE_TELEMETRY: '1',
    CODEX_DISABLE_UPDATE_CHECK: '1',
  }),
  storagePlan(validated: ValidatedReplayInput) {
    const { payload } = validated;
    return Object.freeze({
      nativeFiles: Object.freeze(
        payload.nativeSession.files.map((file) =>
          Object.freeze({
            file,
            relativePath: path.posix.join(
              'cli-home',
              '.codex',
              'sessions',
              'replay',
              payload.source.sessionIdAlias,
              file.role === 'primary'
                ? `rollout-${payload.source.sessionIdAlias}.jsonl`
                : `rollout-${payload.source.sessionIdAlias}-${file.id}.jsonl`,
            ),
          }),
        ),
      ),
    });
  },
  controlFiles() {
    const content = [
      'model_provider = "mosga-local"',
      '',
      '[model_providers.mosga-local]',
      'name = "MOSGA local replay route"',
      'base_url_env = "MOSGA_ROUTE_BASE_URL"',
      'env_key = "MOSGA_ROUTE_TOKEN"',
      'wire_api = "responses"',
      '',
    ].join('\n');
    return Object.freeze([
      Object.freeze({
        relativePath: path.posix.join(
          'cli-home',
          '.codex',
          'config.toml',
        ),
        bytes: new TextEncoder().encode(content),
      }),
    ]);
  },
  launchArguments(validated: ValidatedReplayInput) {
    return Object.freeze([
      'exec',
      'resume',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      validated.payload.source.sessionIdAlias,
      '-',
    ]);
  },
  skillLocations(paths: AdapterPaths) {
    return Object.freeze({
      user: path.join(paths.cliHome, '.codex', 'skills'),
      project: path.join(paths.workingDirectory, '.agents', 'skills'),
    });
  },
  routeInjection(baseUrl: string, token: string, cliModel: string) {
    return Object.freeze({
      environment: Object.freeze({
        MOSGA_ROUTE_BASE_URL: baseUrl,
        MOSGA_ROUTE_TOKEN: token,
        MOSGA_CLI_MODEL: cliModel,
      }),
    });
  },
});

export const codexAdapter: RuntimeAdapter = Object.freeze({
  sourceCli: 'codex',
  profiles: Object.freeze([CODEX_PROFILE]),
});
