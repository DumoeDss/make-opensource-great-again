import type { SourceCli } from '@mosga/contracts';

import type {
  ReplayCleanupState,
  ReplayRuntimeErrorCode,
  ReplayRuntimeFailure,
  ReplayRuntimeStage,
} from './types.js';

export class RuntimeFault extends Error {
  constructor(
    readonly code: ReplayRuntimeErrorCode,
    readonly stage: ReplayRuntimeStage,
    readonly sourceCli: SourceCli | null = null,
    readonly replayCliVersion: string | null = null,
  ) {
    super(code);
    this.name = 'ReplayRuntimeInternalFault';
  }
}

export function safeFailure(
  fault: RuntimeFault,
  cleanup: ReplayCleanupState,
): ReplayRuntimeFailure {
  return Object.freeze({
    code: fault.code,
    stage: fault.stage,
    sourceCli: fault.sourceCli,
    replayCliVersion: fault.replayCliVersion,
    cleanup,
  });
}

export function asRuntimeFault(
  cause: unknown,
  fallbackCode: ReplayRuntimeErrorCode,
  stage: ReplayRuntimeStage,
  sourceCli: SourceCli | null,
  replayCliVersion: string | null,
): RuntimeFault {
  if (cause instanceof RuntimeFault) {
    if (
      (cause.sourceCli === null && sourceCli !== null) ||
      (cause.replayCliVersion === null &&
        replayCliVersion !== null)
    ) {
      return new RuntimeFault(
        cause.code,
        cause.stage,
        cause.sourceCli ?? sourceCli,
        cause.replayCliVersion ?? replayCliVersion,
      );
    }
    return cause;
  }
  return new RuntimeFault(
        fallbackCode,
        stage,
        sourceCli,
        replayCliVersion,
      );
}
