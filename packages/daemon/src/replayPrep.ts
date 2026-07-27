/**
 * Replay preparation helpers: instruction-candidate discovery + terminal-manifest
 * seed / runtime-policy construction from a native capture.
 *
 * These are the daemon-side glue between the session-readers' `captureNativeSession`
 * and the `@mosga/replay-bundle` foundation's `createReplayDraft`. The foundation
 * performs NO discovery; the caller supplies explicit candidates. This module
 * implements the conservative v1 discovery heuristic documented in the design's
 * open questions: scan the session's project cwd for `CLAUDE.md` / `AGENTS.md`
 * only. Unknown/missing cwd yields zero candidates (the bundle records the
 * omission explicitly) — it never guesses a broader project tree.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  InstructionCandidate,
  NativeCaptureSuccess,
  ReplayDeliveryTarget,
  ReplayOmission,
  ReplayRuntimePolicy,
  SanitizationProvenance,
  TerminalManifestSeed,
} from '@mosga/contracts';

/** The fixed v1 sanitizer package version stamped into the seed's provenance. */
export const SANITIZER_PACKAGE_VERSION = '0.1.0';

/**
 * Discover instruction candidates from the session's project cwd. v1 scans ONLY
 * the cwd for `CLAUDE.md` and `AGENTS.md` (the documented project-scope files).
 * Each candidate carries a deterministic, non-leaking `stagePath` — the original
 * absolute path is validated as input but never stored or hashed by the bundle.
 *
 * Returns an empty array (not an error) when the cwd is unknown or the files are
 * absent; the bundle records the omission explicitly. A read/decode failure on a
 * file that exists is skipped (degrade cleanly, same discipline as enumeration).
 */
export function discoverInstructionCandidates(
  cwd: string | null | undefined,
): InstructionCandidate[] {
  if (!cwd) return [];
  const candidates: InstructionCandidate[] = [];
  const files: Array<{ basename: string; kind: 'claude-md' | 'agents-md' }> = [
    { basename: 'CLAUDE.md', kind: 'claude-md' },
    { basename: 'AGENTS.md', kind: 'agents-md' },
  ];
  for (const { basename, kind } of files) {
    const sourcePath = path.join(cwd, basename);
    let content: string;
    try {
      const buf = fs.readFileSync(sourcePath);
      // Fatal-decode as UTF-8 (the bundle foundation does the same; non-UTF-8
      // instruction content is unsupported in v1). A decode failure is skipped.
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      continue;
    }
    candidates.push({
      sourcePath,
      kind,
      stagePath: `project/${basename}`,
      effectiveOrder: candidates.length,
      content,
    });
  }
  return candidates;
}

/**
 * Build the omissions array for a freshly prepared draft. Records the
 * source-context omissions that are structurally unavailable to the replay
 * bundle: repository identity (not retained by the native capture) and
 * project instructions when none were discovered.
 */
export function buildInitialOmissions(
  instructionCandidateCount: number,
): ReplayOmission[] {
  const omissions: ReplayOmission[] = [
    {
      id: 'omission-repository-identity',
      category: 'source-context',
      reason: 'not-recorded',
      disclosure: 'Repository identity (git remote, branch, commit) was not retained by the native session capture.',
      relatedId: 'repository',
    },
  ];
  if (instructionCandidateCount === 0) {
    omissions.push({
      id: 'omission-no-instructions',
      category: 'instruction',
      reason: 'unavailable',
      disclosure: 'No CLAUDE.md or AGENTS.md instruction files were found in the project directory; the CLI resumes without project instructions.',
      relatedId: 'instructions',
    });
  }
  return omissions;
}

/**
 * Build the `TerminalManifestSeed` from the capture's safe source summary,
 * trajectory, the user-chosen delivery target, and the fixed v1 sanitization
 * provenance. The seed's source/trajectory/delivery are deep-cloned from the
 * capture so the identity check inside `createReplayDraft` passes.
 */
export function buildTerminalManifestSeed(
  capture: NativeCaptureSuccess,
  delivery: ReplayDeliveryTarget,
  sanitization: SanitizationProvenance,
): TerminalManifestSeed {
  return {
    schemaVersion: '1.0.0',
    kind: 'mosga-replay-terminal-manifest-seed',
    purpose: 'open-source-contribution',
    source: structuredClone(capture.source),
    trajectory: structuredClone(capture.trajectory),
    sanitization,
    omissionPolicy: 'explicit-known-omissions',
    replayMode: 'cli-resume',
    instructionPolicy: 'sanitized-snapshot',
    skillPolicy: 'cli-discovery-read-only',
    proxyRescan: false,
    maxInferenceRequests: 1,
    delivery: structuredClone(delivery),
  };
}

/**
 * Build the fixed v1 `ReplayRuntimePolicy`. The replay/instruction/skill/proxy/
 * max-inference fields are the locked v1 constants; the project + working-dir
 * aliases are deterministic, non-leaking derivations of the session id alias.
 */
export function buildReplayRuntimePolicy(
  capture: NativeCaptureSuccess,
): ReplayRuntimePolicy {
  const aliasBase = deriveProjectAlias(capture.artifact.sessionIdAlias);
  return {
    schemaVersion: '1.0.0',
    replayMode: 'cli-resume',
    instructionPolicy: 'sanitized-snapshot',
    skillPolicy: 'cli-discovery-read-only',
    proxyRescan: false,
    maxInferenceRequests: 1,
    projectAlias: aliasBase,
    workingDirectoryAlias: `workspace/${aliasBase}`,
  };
}

/** Build the sanitization provenance stamped into the terminal-manifest seed. */
export function buildSanitizationProvenance(
  rulesetVersion: string,
  reportVersion: string,
): SanitizationProvenance {
  return {
    rulesetVersion,
    reportVersion,
    sanitizerPackageVersion: SANITIZER_PACKAGE_VERSION,
  };
}

/**
 * Derive a deterministic, non-leaking project alias from the session id alias.
 * The session id alias is already a safe identifier emitted by the source
 * adapter; hashing it yields a stable, unique alias that does not echo the
 * original path or username into the scanned draft content.
 */
function deriveProjectAlias(sessionIdAlias: string): string {
  const hash = createHash('sha256')
    .update('mosga-replay-project-alias:v1')
    .update('\0')
    .update(sessionIdAlias)
    .digest('hex')
    .slice(0, 8);
  return `project-${hash}`;
}

/** Generate a fresh, unique draft id for a replay preparation. */
export function newDraftId(): string {
  return `replay-draft-${randomUUID()}`;
}

/** Generate a fresh, unique decision version for a replay seal. */
export function newDecisionVersion(): string {
  return `decisions-${randomUUID()}`;
}
