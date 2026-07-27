// Owned immutable launch snapshot (closes STD-B1).
//
// The SINGLE place that reads caller-supplied execution values. Every
// security-relevant scalar on `input.route` and `input.terminalInput` is read
// EXACTLY ONCE into a local const, validated, and copied into a frozen
// null-prototype snapshot. Everything downstream — collision check, environment
// build, argv build, supervisor stdin delivery — consumes the owned snapshot.
// The caller's `route` / `terminalInput` references are dead past the single
// capture call, so a getter/proxy that flips baseUrl loopback→remote (or
// returns a terminal decoy to a later collision check) flips nothing: the
// second read never happens.
import { isDeepStrictEqual } from 'node:util';

import type { SourceCli } from '@mosga/contracts';

import type { CapabilityProfile } from './adapters/types.js';
import type { RuntimeConfig } from './config.js';
import { buildReplayEnvironment } from './environment.js';
import {
  containsUnpairedSurrogate,
  isLoopbackHost,
} from './executionInput.js';
import { RuntimeFault } from './errors.js';
import type { OwnedExecutable } from './ownedExecutable.js';
import type {
  ExecutePreparedReplayInput,
  ReplayRouteBinding,
  ReplayRouteRequirement,
} from './types.js';
import type { ValidatedReplayInput } from './validated.js';
import type { ReplayWorkspace } from './workspace.js';

export interface OwnedRouteSnapshot {
  readonly sourceCli: SourceCli;
  readonly wireProtocol: 'anthropic-messages' | 'openai-responses';
  readonly transport: 'loopback-http';
  readonly authScheme: 'route-bearer';
  readonly targetProviderId: string;
  readonly targetModel: string;
  readonly baseUrl: string;
  readonly routeToken: string;
  readonly cliModel: string;
}

export interface OwnedTerminalSnapshot {
  readonly text: string;
  readonly bytes: Uint8Array;
}

export interface OwnedLaunchSnapshot {
  readonly route: OwnedRouteSnapshot;
  readonly terminal: OwnedTerminalSnapshot;
  readonly timeoutMs: number;
}

export interface OwnedLaunchPlan {
  readonly executable: OwnedExecutable;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

const ROUTE_KEYS = Object.freeze([
  'authScheme',
  'baseUrl',
  'cliModel',
  'routeToken',
  'sourceCli',
  'targetModel',
  'targetProviderId',
  'transport',
  'wireProtocol',
]);

function exactRouteKeys(route: ReplayRouteBinding): boolean {
  return isDeepStrictEqual(
    Object.keys(route).sort(),
    ROUTE_KEYS as readonly string[],
  );
}

/**
 * Read every route scalar exactly once, validate, and return a frozen
 * null-prototype snapshot. The caller's `route` object is never read again by
 * any later stage.
 */
export function captureOwnedRoute(
  route: ReplayRouteBinding,
  requirement: ReplayRouteRequirement,
): OwnedRouteSnapshot {
  if (
    route === null ||
    typeof route !== 'object' ||
    Array.isArray(route)
  ) {
    throw new RuntimeFault(
      'route-binding-invalid',
      'launch',
      requirement.sourceCli,
    );
  }
  // ONE read per scalar. A getter-backed route that returns a loopback URL on
  // the first read and a remote attacker URL on subsequent reads gets exactly
  // one read per field here.
  const sourceCli = route.sourceCli;
  const wireProtocol = route.wireProtocol;
  const transport = route.transport;
  const authScheme = route.authScheme;
  const targetProviderId = route.targetProviderId;
  const targetModel = route.targetModel;
  const baseUrl = route.baseUrl;
  const routeToken = route.routeToken;
  const cliModel = route.cliModel;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RuntimeFault(
      'route-binding-invalid',
      'launch',
      requirement.sourceCli,
    );
  }

  // Reject surplus/missing keys (defense in depth; reads via the captured
  // locals above are unaffected by later key enumeration).
  if (!exactRouteKeys(route)) {
    throw new RuntimeFault(
      'route-binding-invalid',
      'launch',
      requirement.sourceCli,
    );
  }

  if (
    sourceCli !== requirement.sourceCli ||
    wireProtocol !== requirement.wireProtocol ||
    transport !== requirement.transport ||
    authScheme !== requirement.authScheme ||
    targetProviderId !== requirement.targetProviderId ||
    targetModel !== requirement.targetModel ||
    parsed.protocol !== 'http:' ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.port.length === 0 ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0 ||
    parsed.hash.length !== 0 ||
    parsed.search.length !== 0 ||
    routeToken.length === 0 ||
    routeToken.length > 4_096 ||
    routeToken.includes('\0') ||
    cliModel.length === 0 ||
    cliModel.length > 256 ||
    cliModel.includes('\0')
  ) {
    throw new RuntimeFault(
      'route-binding-invalid',
      'launch',
      requirement.sourceCli,
    );
  }

  const snapshot = Object.assign(Object.create(null), {
    sourceCli,
    wireProtocol,
    transport,
    authScheme,
    targetProviderId,
    targetModel,
    baseUrl,
    routeToken,
    cliModel,
  });
  return Object.freeze(snapshot) as OwnedRouteSnapshot;
}

/**
 * Read the terminal input string exactly once, validate it, encode UTF-8 bytes
 * from that same local, and return the frozen { text, bytes } pair. The
 * caller's `terminalInput` is never read again by any later stage (collision
 * check, environment build, supervisor stdin all consume this snapshot).
 */
export function captureOwnedTerminal(
  terminalInput: string,
  config: RuntimeConfig,
  sourceCli: SourceCli,
  replayCliVersion: string,
): OwnedTerminalSnapshot {
  // ONE read of the caller's value into a local. typeof guards read it once.
  if (
    typeof terminalInput !== 'string' ||
    terminalInput.length === 0 ||
    terminalInput.includes('\0') ||
    containsUnpairedSurrogate(terminalInput)
  ) {
    throw new RuntimeFault(
      'terminal-input-invalid',
      'launch',
      sourceCli,
      replayCliVersion,
    );
  }
  const bytes = new TextEncoder().encode(terminalInput);
  if (bytes.byteLength > config.limits.terminalInputBytes) {
    throw new RuntimeFault(
      'terminal-input-invalid',
      'launch',
      sourceCli,
      replayCliVersion,
    );
  }
  const snapshot = Object.assign(Object.create(null), {
    text: terminalInput,
    // bytes is a fresh TextEncoder allocation, not shared with the caller; the
    // snapshot field is fixed by the outer freeze. (Object.freeze on a typed
    // array throws "Cannot freeze array buffer views with elements", and is
    // unnecessary — the bytes are never mutated after capture.)
    bytes,
  });
  return Object.freeze(snapshot) as OwnedTerminalSnapshot;
}

/**
 * Capture the full launch snapshot from the execute input: route + terminal +
 * timeoutMs. Each caller field is read exactly once. The execute-input
 * envelope shape is NOT validated here (the caller does that), and the abort
 * signal is NOT consumed here.
 */
export function captureOwnedLaunchSnapshot(
  input: ExecutePreparedReplayInput,
  requirement: ReplayRouteRequirement,
  config: RuntimeConfig,
  replayCliVersion: string,
): OwnedLaunchSnapshot {
  // ONE read each of input.route and input.terminalInput.
  const route = captureOwnedRoute(input.route, requirement);
  const terminal = captureOwnedTerminal(
    input.terminalInput,
    config,
    route.sourceCli,
    replayCliVersion,
  );
  const timeoutMs =
    input.timeoutMs === undefined
      ? config.limits.executionTimeoutMs
      : input.timeoutMs;
  const snapshot = Object.assign(Object.create(null), {
    route,
    terminal,
    timeoutMs,
  });
  return Object.freeze(snapshot) as OwnedLaunchSnapshot;
}

/**
 * Cross-field collision check over the OWNED snapshot. Proves no route scalar
 * contains the owned terminal text, no argv/env value leaks the owned terminal
 * text, and no non-route env name leaks the owned route token. Consumes only
 * the frozen owned values — the caller's objects are already dead.
 */
export function checkOwnedCollisions(
  snapshot: OwnedLaunchSnapshot,
  profile: CapabilityProfile,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
): void {
  const { route, terminal } = snapshot;
  // Terminal text must not appear inside any route scalar.
  if (
    route.baseUrl.includes(terminal.text) ||
    route.routeToken.includes(terminal.text) ||
    route.cliModel.includes(terminal.text)
  ) {
    throw new RuntimeFault(
      'route-binding-invalid',
      'launch',
      route.sourceCli,
    );
  }
  // Terminal text must not appear in any argv/env value.
  if (argv.some((value) => value.includes(terminal.text))) {
    throw new RuntimeFault(
      'runtime-policy-unsupported',
      'launch',
      route.sourceCli,
    );
  }
  if (
    Object.values(environment).some((value) =>
      value.includes(terminal.text),
    )
  ) {
    throw new RuntimeFault(
      'runtime-policy-unsupported',
      'launch',
      route.sourceCli,
    );
  }
  // Route token must not leak into a non-route env name, and argv must not
  // contain the route token at all.
  if (argv.some((value) => value.includes(route.routeToken))) {
    throw new RuntimeFault(
      'runtime-policy-unsupported',
      'launch',
      route.sourceCli,
    );
  }
  if (
    Object.entries(environment).some(
      ([key, value]) =>
        !profile.routeEnvironmentNames.includes(key) &&
        value.includes(route.routeToken),
    )
  ) {
    throw new RuntimeFault(
      'runtime-policy-unsupported',
      'launch',
      route.sourceCli,
    );
  }
}

/**
 * Build the owned launch plan's argv + environment from the snapshot, profile,
 * workspace, and validated bundle — then run the collision check. The
 * executable is bound separately by the caller (it is staged during prepare).
 */
export function buildOwnedLaunchPlan(
  snapshot: OwnedLaunchSnapshot,
  profile: CapabilityProfile,
  workspace: ReplayWorkspace,
  validated: ValidatedReplayInput,
  executable: OwnedExecutable,
): OwnedLaunchPlan {
  const environment = buildReplayEnvironment(
    profile,
    workspace,
    snapshot.route,
  );
  const argv = Object.freeze([...profile.launchArguments(validated)]);
  checkOwnedCollisions(snapshot, profile, argv, environment);
  return Object.freeze({
    executable,
    argv,
    cwd: workspace.paths.workingDirectory,
    environment,
  });
}
