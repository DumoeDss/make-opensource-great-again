import {
  captureExecutableIdentity,
  executableIdentityMatches,
  probeAdapter,
  resolveTrustedBinary,
  type ExecutableIdentity,
} from './adapters/capabilityProbe.js';
import {
  runtimeAdapterFor,
  selectCapabilityProfile,
} from './adapters/registry.js';
import type {
  CapabilityProfile,
  ProbeEvidence,
  RuntimeAdapter,
} from './adapters/types.js';
import {
  normalizeRuntimeOptions,
  validateSkillDescriptors,
  type RuntimeConfig,
} from './config.js';
import {
  asRuntimeFault,
  RuntimeFault,
  safeFailure,
} from './errors.js';
import { createRouteRequirement } from './executionInput.js';
import {
  buildOwnedLaunchPlan,
  captureOwnedLaunchSnapshot,
  type OwnedLaunchPlan,
  type OwnedLaunchSnapshot,
} from './ownedLaunchSnapshot.js';
import {
  stageOwnedExecutable,
  type OwnedExecutable,
} from './ownedExecutable.js';
import type { ProcessTreeBoundaryFactory } from './processTreeBoundary.js';
import {
  superviseReplayProcess,
  type ProcessPlatformHost,
  type SupervisedProcessResult,
} from './processSupervisor.js';
import { exposeSkillSnapshots } from './skills.js';
import type {
  ExecutePreparedReplayInput,
  PreparedReplay,
  ReplayCleanupResult,
  ReplayExecutionResult,
  ReplayPreparationObservation,
  ReplayPrepareResult,
  ReplayRuntime,
  ReplayRuntimeOptions,
  ReplaySkillRoot,
} from './types.js';
import {
  validateAndBrandReplayBundle,
  type ValidatedReplayInput,
} from './validated.js';
import {
  cleanupReplayWorkspace,
  cleanupStaleReplayRoots,
  createReplayWorkspace,
  type ReplayRootOwnership,
  type ReplayWorkspace,
} from './workspace.js';

export interface RuntimeDependencies {
  resolveBinary(
    sourceCli: ValidatedReplayInput['payload']['source']['sourceCli'],
    config: RuntimeConfig,
  ): Promise<string>;
  probe(
    adapter: RuntimeAdapter,
    executable: string,
    config: RuntimeConfig,
    signal?: AbortSignal,
    expectedIdentity?: ExecutableIdentity,
  ): Promise<ProbeEvidence>;
  captureExecutable(
    executable: string,
    sourceCli: ValidatedReplayInput['payload']['source']['sourceCli'],
  ): Promise<ExecutableIdentity>;
  stageOwnedExecutable(
    originalPath: string,
    runtimeDir: string,
    probedIdentity: ExecutableIdentity,
    sourceCli: ValidatedReplayInput['payload']['source']['sourceCli'],
  ): Promise<OwnedExecutable>;
  createWorkspace(
    config: RuntimeConfig,
    validated: ValidatedReplayInput,
    profile: CapabilityProfile,
    claimOwnership: (ownership: ReplayRootOwnership) => void,
  ): Promise<ReplayWorkspace>;
  exposeSkills(
    roots: readonly ReplaySkillRoot[],
    profile: CapabilityProfile,
    workspace: ReplayWorkspace,
    config: RuntimeConfig,
  ): Promise<void>;
  supervise(
    plan: OwnedLaunchPlan,
    stdinBytes: Uint8Array,
    timeoutMs: number,
    signals: readonly AbortSignal[],
    config: RuntimeConfig,
    sourceCli: ValidatedReplayInput['payload']['source']['sourceCli'],
    replayCliVersion: string,
    host?: ProcessPlatformHost,
    boundaryFactory?: ProcessTreeBoundaryFactory,
    preSpawnHook?: () => void | Promise<void>,
  ): Promise<SupervisedProcessResult>;
  cleanup(
    target: ReplayWorkspace | ReplayRootOwnership,
    config: RuntimeConfig,
  ): Promise<void>;
  staleCleanup(config: RuntimeConfig): Promise<void>;
}

const defaultDependencies: RuntimeDependencies = Object.freeze({
  resolveBinary: resolveTrustedBinary,
  probe: probeAdapter,
  captureExecutable: captureExecutableIdentity,
  stageOwnedExecutable,
  createWorkspace: createReplayWorkspace,
  exposeSkills: exposeSkillSnapshots,
  supervise: superviseReplayProcess,
  cleanup: cleanupReplayWorkspace,
  staleCleanup: cleanupStaleReplayRoots,
});

function immutableObservation(
  validated: ValidatedReplayInput,
  profile: CapabilityProfile,
  replayCliVersion: string,
): ReplayPreparationObservation {
  const delivery = Object.freeze({
    ...validated.payload.delivery,
  });
  const routeRequirement = Object.freeze(
    createRouteRequirement(validated, profile),
  );
  return Object.freeze({
    sourceCli: validated.payload.source.sourceCli,
    bundleContentHash: validated.contentHash,
    recordedCliVersion:
      validated.payload.source.recordedCliVersion,
    replayCliVersion,
    capabilityProfileId: profile.id,
    delivery,
    routeRequirement,
  });
}

function createPreparedReplayFacade(
  observation: ReplayPreparationObservation,
  ownedExecutable: OwnedExecutable,
  validated: ValidatedReplayInput,
  profile: CapabilityProfile,
  workspace: ReplayWorkspace,
  config: RuntimeConfig,
  dependencies: RuntimeDependencies,
): PreparedReplay {
  let state:
    | 'prepared'
    | 'running'
    | 'consumed'
    | 'cleaning'
    | 'disposed' = 'prepared';
  const disposalAbort = new AbortController();
  let executionPromise: Promise<ReplayExecutionResult> | null = null;
  let cleanupPromise: Promise<ReplayCleanupResult> | null = null;
  let blockedCleanupFault: RuntimeFault | null = null;

  const ensureCleanup = (): Promise<ReplayCleanupResult> => {
    if (cleanupPromise !== null) return cleanupPromise;
    state = 'cleaning';
    cleanupPromise = (async () => {
      if (blockedCleanupFault !== null) {
        state = 'disposed';
        return Object.freeze({
          ok: false as const,
          error: safeFailure(blockedCleanupFault, 'failed'),
        });
      }
      try {
        await dependencies.cleanup(workspace, config);
        state = 'disposed';
        return Object.freeze({
          ok: true as const,
          cleanup: 'complete' as const,
        });
      } catch {
        state = 'disposed';
        return Object.freeze({
          ok: false as const,
          error: safeFailure(
            new RuntimeFault(
              'cleanup-failed',
              'cleanup',
              observation.sourceCli,
              observation.replayCliVersion,
            ),
            'failed',
          ),
        });
      }
    })();
    return cleanupPromise;
  };

  const consumedFailure = async (): Promise<ReplayExecutionResult> => {
    if (executionPromise !== null) await executionPromise;
    const cleanup = await ensureCleanup();
    return Object.freeze({
      ok: false as const,
      error: safeFailure(
        new RuntimeFault(
          'prepared-replay-consumed',
          'launch',
          observation.sourceCli,
          observation.replayCliVersion,
        ),
        cleanup.ok ? 'complete' : 'failed',
      ),
    });
  };

  const runOnce = async (
    input: ExecutePreparedReplayInput,
  ): Promise<ReplayExecutionResult> => {
    let processResult: SupervisedProcessResult | null = null;
    let fault: RuntimeFault | null = null;
    try {
      if (
        input === null ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) =>
            !['terminalInput', 'route', 'timeoutMs', 'signal'].includes(
              key,
            ),
        )
      ) {
        throw new RuntimeFault(
          'runtime-policy-unsupported',
          'launch',
          observation.sourceCli,
          observation.replayCliVersion,
        );
      }
      if (input.signal?.aborted || disposalAbort.signal.aborted) {
        throw new RuntimeFault(
          'cancelled',
          'terminate',
          observation.sourceCli,
          observation.replayCliVersion,
        );
      }
      // Capture every caller-supplied execution scalar into an immutable owned
      // snapshot — each field read EXACTLY ONCE (closes STD-B1). The caller's
      // input.route / input.terminalInput references are dead past this call.
      const snapshot: OwnedLaunchSnapshot = captureOwnedLaunchSnapshot(
        input,
        observation.routeRequirement,
        config,
        observation.replayCliVersion,
      );
      // Build the owned launch plan (environment + argv from the frozen owned
      // snapshot + the staged OwnedExecutable) and run collision checks over
      // the owned values.
      const plan = buildOwnedLaunchPlan(
        snapshot,
        profile,
        workspace,
        validated,
        ownedExecutable,
      );

      processResult = await dependencies.supervise(
        plan,
        snapshot.terminal.bytes,
        snapshot.timeoutMs,
        [
          disposalAbort.signal,
          ...(input.signal === undefined ? [] : [input.signal]),
        ],
        config,
        observation.sourceCli,
        observation.replayCliVersion,
      );
    } catch (error) {
      fault = asRuntimeFault(
        error,
        'process-spawn-failed',
        'launch',
        observation.sourceCli,
        observation.replayCliVersion,
      );
    }

    state = 'consumed';
    if (fault?.code === 'cleanup-failed' && fault.stage === 'terminate') {
      blockedCleanupFault = fault;
    }
    const cleanup = await ensureCleanup();
    if (!cleanup.ok) {
      return Object.freeze({
        ok: false as const,
        error: cleanup.error,
      });
    }
    if (fault !== null || processResult === null) {
      return Object.freeze({
        ok: false as const,
        error: safeFailure(
          fault ??
            new RuntimeFault(
              'process-exit-failed',
              'run',
              observation.sourceCli,
              observation.replayCliVersion,
            ),
          'complete',
        ),
      });
    }
    return Object.freeze({
      ok: true as const,
      observation,
      startedAt: new Date(processResult.startedAtMs).toISOString(),
      completedAt: new Date(
        processResult.completedAtMs,
      ).toISOString(),
      durationMs: Math.max(
        0,
        processResult.completedAtMs - processResult.startedAtMs,
      ),
      exitStatus: 0 as const,
    });
  };

  const execute = (
    input: ExecutePreparedReplayInput,
  ): Promise<ReplayExecutionResult> => {
    if (state !== 'prepared') return consumedFailure();
    state = 'running';
    executionPromise = runOnce(input);
    return executionPromise;
  };
  const dispose = async (): Promise<ReplayCleanupResult> => {
    if (state === 'running') {
      disposalAbort.abort();
      if (executionPromise !== null) await executionPromise;
    }
    if (state === 'prepared') state = 'consumed';
    return await ensureCleanup();
  };
  Object.setPrototypeOf(execute, null);
  Object.setPrototypeOf(dispose, null);
  Object.freeze(execute);
  Object.freeze(dispose);
  const facade = Object.create(null) as PreparedReplay;
  Object.defineProperties(facade, {
    observation: {
      value: observation,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    execute: {
      value: execute,
      enumerable: true,
      writable: false,
      configurable: false,
    },
    dispose: {
      value: dispose,
      enumerable: true,
      writable: false,
      configurable: false,
    },
  });
  return Object.freeze(facade);
}

export function createReplayRuntimeInternal(
  options: ReplayRuntimeOptions = {},
  dependencies: RuntimeDependencies = defaultDependencies,
): ReplayRuntime {
  const fixedDependencies: RuntimeDependencies = Object.freeze({
    resolveBinary: dependencies.resolveBinary,
    probe: dependencies.probe,
    captureExecutable: dependencies.captureExecutable,
    stageOwnedExecutable: dependencies.stageOwnedExecutable,
    createWorkspace: dependencies.createWorkspace,
    exposeSkills: dependencies.exposeSkills,
    supervise: dependencies.supervise,
    cleanup: dependencies.cleanup,
    staleCleanup: dependencies.staleCleanup,
  });
  return Object.freeze({
    async prepare(
      input: Parameters<ReplayRuntime['prepare']>[0],
    ): Promise<ReplayPrepareResult> {
      let validated: ValidatedReplayInput;
      try {
        validated = validateAndBrandReplayBundle(input?.bundle);
      } catch (error) {
        const fault = asRuntimeFault(
          error,
          'bundle-invalid',
          'validate',
          null,
          null,
        );
        return Object.freeze({
          ok: false as const,
          error: safeFailure(fault, 'not-created'),
        });
      }

      let config: RuntimeConfig;
      let skillRoots: readonly ReplaySkillRoot[];
      try {
        config = normalizeRuntimeOptions(options);
        skillRoots = validateSkillDescriptors(input.skillRoots);
      } catch (error) {
        const fault = asRuntimeFault(
          error,
          'runtime-policy-unsupported',
          'validate',
          validated.payload.source.sourceCli,
          null,
        );
        return Object.freeze({
          ok: false as const,
          error: safeFailure(fault, 'not-created'),
        });
      }

      const sourceCli = validated.payload.source.sourceCli;
      let replayCliVersion: string | null = null;
      let workspace: ReplayWorkspace | null = null;
      let cleanupTarget: ReplayWorkspace | ReplayRootOwnership | null =
        null;
      try {
        if (input.signal?.aborted) {
          throw new RuntimeFault(
            'cancelled',
            'probe',
            sourceCli,
          );
        }
        const adapter = runtimeAdapterFor(sourceCli);
        const executable = await fixedDependencies.resolveBinary(
          sourceCli,
          config,
        );
        const identityBeforeProbe =
          await fixedDependencies.captureExecutable(
            executable,
            sourceCli,
          );
        const evidence = await fixedDependencies.probe(
          adapter,
          executable,
          config,
          input.signal,
          identityBeforeProbe,
        );
        let identityAfterProbe: ExecutableIdentity;
        try {
          identityAfterProbe =
            await fixedDependencies.captureExecutable(
              executable,
              sourceCli,
            );
        } catch {
          throw new RuntimeFault(
            'cli-probe-failed',
            'probe',
            sourceCli,
          );
        }
        if (
          !executableIdentityMatches(
            identityBeforeProbe,
            identityAfterProbe,
          )
        ) {
          throw new RuntimeFault(
            'cli-probe-failed',
            'probe',
            sourceCli,
          );
        }
        replayCliVersion = evidence.version;
        const profile = selectCapabilityProfile(
          adapter,
          validated,
          evidence,
        );
        await fixedDependencies.staleCleanup(config).catch(() => {});
        if (input.signal?.aborted) {
          throw new RuntimeFault(
            'cancelled',
            'probe',
            sourceCli,
            replayCliVersion,
          );
        }
        workspace = await fixedDependencies.createWorkspace(
          config,
          validated,
          profile,
          (ownership) => {
            if (cleanupTarget !== null) {
              throw new RuntimeFault(
                'workspace-create-failed',
                'materialize',
                sourceCli,
                replayCliVersion,
              );
            }
            cleanupTarget = ownership;
          },
        );
        cleanupTarget = workspace;
        await fixedDependencies.exposeSkills(
          skillRoots,
          profile,
          workspace,
          config,
        );
        if (input.signal?.aborted) {
          throw new RuntimeFault(
            'cancelled',
            'materialize',
            sourceCli,
            replayCliVersion,
          );
        }
        // Stage the runtime-owned immutable executable copy (closes STD-M1). The
        // supervisor spawns this copy — never the original resolved path — and
        // re-verifies its identity immediately before host.spawn.
        const ownedExecutable = await fixedDependencies.stageOwnedExecutable(
          executable,
          workspace.paths.runtime,
          identityAfterProbe,
          sourceCli,
        );
        const observation = immutableObservation(
          validated,
          profile,
          replayCliVersion,
        );
        return Object.freeze({
          ok: true as const,
          prepared: createPreparedReplayFacade(
            observation,
            ownedExecutable,
            validated,
            profile,
            workspace,
            config,
            fixedDependencies,
          ),
        });
      } catch (error) {
        let cleanup: 'not-created' | 'complete' | 'failed' =
          cleanupTarget === null ? 'not-created' : 'complete';
        if (cleanupTarget !== null) {
          try {
            await fixedDependencies.cleanup(cleanupTarget, config);
          } catch {
            cleanup = 'failed';
          }
        }
        const contextual =
          cleanup === 'failed'
            ? new RuntimeFault(
                'cleanup-failed',
                'cleanup',
                sourceCli,
                replayCliVersion,
              )
            : asRuntimeFault(
                error,
                'workspace-materialize-failed',
                'materialize',
                sourceCli,
                replayCliVersion,
              );
        return Object.freeze({
          ok: false as const,
          error: safeFailure(contextual, cleanup),
        });
      }
    },
  });
}

export function createReplayRuntime(
  options: ReplayRuntimeOptions = {},
): ReplayRuntime {
  return createReplayRuntimeInternal(options);
}
