import path from 'node:path';

import type {
  AdapterPaths,
  CapabilityProfile,
  RuntimeAdapter,
} from './types.js';
import type { ValidatedReplayInput } from '../validated.js';

function versionMatches(version: string): boolean {
  const match = /^2\.1\.(\d+)$/.exec(version);
  return match !== null && Number(match[1]) <= 99;
}

export const CLAUDE_CODE_PROFILE: CapabilityProfile = Object.freeze({
  id: 'claude-code-2.1-headless-resume-v1',
  sourceCli: 'claude-code',
  sourceFormat: 'claude-code-jsonl',
  wireProtocol: 'anthropic-messages',
  probeCommands: Object.freeze([
    Object.freeze({ id: 'version', argv: Object.freeze(['--version']) }),
    Object.freeze({ id: 'help', argv: Object.freeze(['--help']) }),
  ]),
  versionMatches,
  requiredMarkers: Object.freeze([
    '--print',
    '--resume',
    '--dangerously-skip-permissions',
    'stdin',
    'anthropic_base_url',
    'isolated-home',
  ]),
  storageLayoutId: 'claude-project-session-jsonl-v1',
  invocationId: 'claude-print-resume-stdin-v1',
  stdinSupported: true,
  isolatedHomeSupported: true,
  deterministicCwdSupported: true,
  routeEnvironmentNames: Object.freeze([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
  ]),
  telemetryEnvironment: Object.freeze({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  }),
  storagePlan(validated: ValidatedReplayInput) {
    const { payload } = validated;
    const projectKey = payload.runtimePolicy.workingDirectoryAlias
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^-+/, '');
    return Object.freeze({
      nativeFiles: Object.freeze(
        payload.nativeSession.files.map((file, index) =>
          Object.freeze({
            file,
            relativePath: path.posix.join(
              'cli-home',
              '.claude',
              'projects',
              projectKey,
              file.role === 'primary'
                ? `${payload.source.sessionIdAlias}.jsonl`
                : `${payload.source.sessionIdAlias}-${file.id}.jsonl`,
            ),
          }),
        ),
      ),
    });
  },
  controlFiles() {
    return Object.freeze([]);
  },
  launchArguments(validated: ValidatedReplayInput) {
    return Object.freeze([
      '--print',
      '--resume',
      validated.payload.source.sessionIdAlias,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ]);
  },
  skillLocations(paths: AdapterPaths) {
    return Object.freeze({
      user: path.join(paths.cliHome, '.claude', 'skills'),
      project: path.join(paths.workingDirectory, '.claude', 'skills'),
    });
  },
  routeInjection(baseUrl: string, token: string, cliModel: string) {
    return Object.freeze({
      environment: Object.freeze({
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_MODEL: cliModel,
      }),
    });
  },
});

export const claudeCodeAdapter: RuntimeAdapter = Object.freeze({
  sourceCli: 'claude-code',
  profiles: Object.freeze([CLAUDE_CODE_PROFILE]),
});
