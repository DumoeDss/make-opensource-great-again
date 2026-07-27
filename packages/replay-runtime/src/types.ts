import type {
  ReplayDeliveryTarget,
  SourceCli,
} from '@mosga/contracts';

export type ReplayRuntimeErrorCode =
  | 'bundle-invalid'
  | 'runtime-policy-unsupported'
  | 'source-cli-unsupported'
  | 'cli-not-found'
  | 'cli-probe-failed'
  | 'cli-version-unsupported'
  | 'cli-capability-unsupported'
  | 'session-layout-unsupported'
  | 'workspace-create-failed'
  | 'workspace-materialize-failed'
  | 'instruction-stage-failed'
  | 'skill-root-invalid'
  | 'skill-exposure-failed'
  | 'prepared-replay-consumed'
  | 'route-binding-invalid'
  | 'terminal-input-invalid'
  | 'process-spawn-failed'
  | 'process-exit-failed'
  | 'process-output-limit'
  | 'cancelled'
  | 'timed-out'
  | 'cleanup-failed';

export type ReplayRuntimeStage =
  | 'validate'
  | 'probe'
  | 'materialize'
  | 'launch'
  | 'run'
  | 'terminate'
  | 'cleanup';

export type ReplayCleanupState = 'not-created' | 'complete' | 'failed';

export interface ReplayRuntimeFailure {
  readonly code: ReplayRuntimeErrorCode;
  readonly stage: ReplayRuntimeStage;
  readonly sourceCli: SourceCli | null;
  readonly replayCliVersion: string | null;
  readonly cleanup: ReplayCleanupState;
}

export interface ReplayRouteRequirement {
  readonly sourceCli: SourceCli;
  readonly wireProtocol: 'anthropic-messages' | 'openai-responses';
  readonly transport: 'loopback-http';
  readonly authScheme: 'route-bearer';
  readonly targetProviderId: string;
  readonly targetModel: string;
}

export interface ReplayRouteBinding extends ReplayRouteRequirement {
  readonly baseUrl: string;
  readonly routeToken: string;
  readonly cliModel: string;
}

export interface ReplayPreparationObservation {
  readonly sourceCli: SourceCli;
  readonly bundleContentHash: `sha256:${string}`;
  readonly recordedCliVersion: string | null;
  readonly replayCliVersion: string;
  readonly capabilityProfileId: string;
  readonly delivery: ReplayDeliveryTarget;
  readonly routeRequirement: ReplayRouteRequirement;
}

export interface ReplayExecutionSuccess {
  readonly ok: true;
  readonly observation: ReplayPreparationObservation;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly exitStatus: 0;
}

export type ReplayExecutionResult =
  | ReplayExecutionSuccess
  | { readonly ok: false; readonly error: ReplayRuntimeFailure };

export type ReplayCleanupResult =
  | { readonly ok: true; readonly cleanup: 'complete' }
  | { readonly ok: false; readonly error: ReplayRuntimeFailure };

export interface ReplaySkillRoot {
  readonly id: string;
  readonly sourcePath: string;
  readonly scope: 'user' | 'project';
  readonly precedence: number;
}

export interface PrepareReplayInput {
  readonly bundle: unknown;
  readonly skillRoots?: readonly ReplaySkillRoot[];
  readonly signal?: AbortSignal;
}

export interface ExecutePreparedReplayInput {
  readonly terminalInput: string;
  readonly route: ReplayRouteBinding;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PreparedReplay {
  readonly observation: ReplayPreparationObservation;
  execute(input: ExecutePreparedReplayInput): Promise<ReplayExecutionResult>;
  dispose(): Promise<ReplayCleanupResult>;
}

export type ReplayPrepareResult =
  | { readonly ok: true; readonly prepared: PreparedReplay }
  | { readonly ok: false; readonly error: ReplayRuntimeFailure };

export interface ReplayRuntime {
  prepare(input: PrepareReplayInput): Promise<ReplayPrepareResult>;
}

export interface ReplayRuntimeLimits {
  readonly probeTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly probeOutputBytes?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly combinedOutputBytes?: number;
  readonly terminalInputBytes?: number;
  readonly skillFileCount?: number;
  readonly skillFileBytes?: number;
  readonly skillTotalBytes?: number;
  readonly staleRootAgeMs?: number;
}

export interface ReplayRuntimeOptions {
  readonly binaryOverrides?: Partial<Record<SourceCli, string>>;
  readonly tempBase?: string;
  readonly limits?: ReplayRuntimeLimits;
}
