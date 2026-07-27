import type { CapabilityProfile } from './adapters/types.js';
import type { OwnedRouteSnapshot } from './ownedLaunchSnapshot.js';
import type { ReplayWorkspace } from './workspace.js';

function platformEnvironment(): Record<string, string> {
  const values: Record<string, string> = {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
  };
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (systemRoot !== undefined) {
      values.SystemRoot = systemRoot;
      values.WINDIR = systemRoot;
    }
  }
  return values;
}

export function buildReplayEnvironment(
  profile: CapabilityProfile,
  workspace: ReplayWorkspace,
  route: OwnedRouteSnapshot,
): Readonly<Record<string, string>> {
  const { paths } = workspace;
  const routeValues = profile.routeInjection(
    route.baseUrl,
    route.routeToken,
    route.cliModel,
  ).environment;
  const environment: Record<string, string> = {
    ...platformEnvironment(),
    HOME: paths.cliHome,
    USERPROFILE: paths.cliHome,
    XDG_CONFIG_HOME: paths.cliHome,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.cliHome,
    TMPDIR: paths.temporary,
    TEMP: paths.temporary,
    TMP: paths.temporary,
    ...profile.telemetryEnvironment,
    ...routeValues,
  };
  if (profile.sourceCli === 'codex') {
    environment.CODEX_HOME = path.join(paths.cliHome, '.codex');
  } else {
    environment.CLAUDE_CONFIG_DIR = path.join(
      paths.cliHome,
      '.claude',
    );
  }
  const allowed = new Set([
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    ...Object.keys(profile.telemetryEnvironment),
    ...profile.routeEnvironmentNames,
  ]);
  if (Object.keys(environment).some((key) => !allowed.has(key))) {
    throw new TypeError('Replay environment exceeded its profile allowlist.');
  }
  return Object.freeze(environment);
}
import path from 'node:path';
