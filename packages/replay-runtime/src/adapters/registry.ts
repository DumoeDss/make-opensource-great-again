import type { SourceCli } from '@mosga/contracts';

import { claudeCodeAdapter } from './claudeCode.js';
import { codexAdapter } from './codex.js';
import type {
  CapabilityProfile,
  ProbeEvidence,
  RuntimeAdapter,
} from './types.js';
import { RuntimeFault } from '../errors.js';
import type { ValidatedReplayInput } from '../validated.js';

const registry: Readonly<Record<SourceCli, RuntimeAdapter>> = Object.freeze({
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
});

export function runtimeAdapterFor(sourceCli: SourceCli): RuntimeAdapter {
  const adapter = registry[sourceCli];
  if (adapter === undefined) {
    throw new RuntimeFault(
      'source-cli-unsupported',
      'validate',
      sourceCli,
    );
  }
  return adapter;
}

export function selectCapabilityProfile(
  adapter: RuntimeAdapter,
  validated: ValidatedReplayInput,
  evidence: ProbeEvidence,
): CapabilityProfile {
  const source = validated.payload.source;
  if (
    evidence.sourceCli !== adapter.sourceCli ||
    source.sourceCli !== adapter.sourceCli
  ) {
    throw new RuntimeFault(
      'cli-capability-unsupported',
      'probe',
      source.sourceCli,
      evidence.version,
    );
  }
  const versionCandidates = adapter.profiles.filter((profile) =>
    profile.versionMatches(evidence.version),
  );
  if (versionCandidates.length === 0) {
    throw new RuntimeFault(
      'cli-version-unsupported',
      'probe',
      source.sourceCli,
      evidence.version,
    );
  }
  const formatCandidates = versionCandidates.filter(
    (profile) => profile.sourceFormat === source.sourceFormat,
  );
  if (formatCandidates.length === 0) {
    throw new RuntimeFault(
      'session-layout-unsupported',
      'probe',
      source.sourceCli,
      evidence.version,
    );
  }
  const complete = formatCandidates.filter(
    (profile) =>
      profile.stdinSupported &&
      profile.isolatedHomeSupported &&
      profile.deterministicCwdSupported &&
      profile.requiredMarkers.every((marker) =>
        evidence.normalizedMarkers.has(marker),
      ),
  );
  if (complete.length !== 1) {
    throw new RuntimeFault(
      'cli-capability-unsupported',
      'probe',
      source.sourceCli,
      evidence.version,
    );
  }
  return complete[0]!;
}
