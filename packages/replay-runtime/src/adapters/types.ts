import type {
  NativeJsonlFile,
  SourceCli,
} from '@mosga/contracts';

import type { ValidatedReplayInput } from '../validated.js';

export interface ProbeCommand {
  readonly id: string;
  readonly argv: readonly string[];
}

export interface ProbeEvidence {
  readonly sourceCli: SourceCli;
  readonly version: string;
  readonly normalizedMarkers: ReadonlySet<string>;
}

export interface AdapterPaths {
  readonly root: string;
  readonly cliHome: string;
  readonly workspace: string;
  readonly workingDirectory: string;
  readonly runtime: string;
  readonly cache: string;
  readonly temporary: string;
}

export interface StoragePlanEntry {
  readonly file: NativeJsonlFile;
  readonly relativePath: string;
}

export interface StoragePlan {
  readonly nativeFiles: readonly StoragePlanEntry[];
}

export interface ControlFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

export interface LaunchPlan {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface RouteInjection {
  readonly environment: Readonly<Record<string, string>>;
}

export interface CapabilityProfile {
  readonly id: string;
  readonly sourceCli: SourceCli;
  readonly sourceFormat: 'claude-code-jsonl' | 'codex-jsonl';
  readonly wireProtocol: 'anthropic-messages' | 'openai-responses';
  readonly probeCommands: readonly ProbeCommand[];
  readonly versionMatches: (version: string) => boolean;
  readonly requiredMarkers: readonly string[];
  readonly storageLayoutId: string;
  readonly invocationId: string;
  readonly stdinSupported: true;
  readonly isolatedHomeSupported: true;
  readonly deterministicCwdSupported: true;
  readonly routeEnvironmentNames: readonly string[];
  readonly telemetryEnvironment: Readonly<Record<string, string>>;
  storagePlan(
    validated: ValidatedReplayInput,
  ): StoragePlan;
  controlFiles(
    validated: ValidatedReplayInput,
    paths: AdapterPaths,
  ): readonly ControlFile[];
  launchArguments(validated: ValidatedReplayInput): readonly string[];
  skillLocations(
    paths: AdapterPaths,
  ): Readonly<Record<'user' | 'project', string>>;
  routeInjection(
    baseUrl: string,
    token: string,
    cliModel: string,
  ): RouteInjection;
}

export interface RuntimeAdapter {
  readonly sourceCli: SourceCli;
  readonly profiles: readonly CapabilityProfile[];
}
