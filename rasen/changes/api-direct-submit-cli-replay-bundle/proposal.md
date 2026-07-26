## Why

The current direct-submit path only retains a normalized `SanitizedSession`, so it drops source-native rows and runtime-significant metadata that Claude Code or Codex needs to resume a session faithfully. The CLI-authentic replay design therefore needs a separately reviewed, structure-preserving, tamper-evident bundle before any runtime, proxy, or delivery work can safely depend on it.

## What Changes

- Add a versioned `ReplayBundle` contract containing sanitized native-session data, sanitized project-instruction snapshots, fixed terminal-manifest inputs, source/trajectory context, runtime and delivery policies, explicit omissions, review evidence, and an integrity seal.
- Extend Claude Code and Codex session readers with a strict native-capture surface that preserves JSONL row order, row types, structural references, and unknown fields without changing the existing normalized-message APIs.
- Extend sanitizer scanning and disposition application to cover every string leaf in captured native rows and instruction files while retaining surrounding JSON structure and consistent pseudonyms.
- Add safe instruction-snapshot inputs and path rules so reviewed `CLAUDE.md` / `AGENTS.md` content can later be staged at aliased, CLI-recognizable relative scopes without copying the original project.
- Add domain-separated, deterministic SHA-256 sealing and validation over the reviewed bundle payload and its per-entry integrity manifest.
- Add focused fake-fixture tests for Claude/Codex structural preservation, sensitive-data exclusion, path safety, stable hashing, mutation detection, and fail-closed malformed or unsupported input.
- Keep CLI process execution, isolated runtime materialization, skill-root mounting, proxy behavior, consent orchestration, and direct-submit integration outside this foundation change.

## Capabilities

### New Capabilities

- `replay-bundle`: Defines the versioned bundle payload, native-session and instruction-snapshot representations, terminal-manifest seed, review evidence, integrity manifest, deterministic seal/validation APIs, and the foundation preparation boundary.

### Modified Capabilities

- `session-readers`: Adds strict source-native capture for supported Claude Code and Codex JSONL sessions while preserving the existing read-only enumeration and normalized parsing behavior.
- `sanitization-scan`: Adds structure-aware scanning and stable finding locations across native JSONL string leaves and instruction snapshot content.
- `sanitization-apply`: Applies reviewed dispositions to replay inputs without normalizing or dropping unrelated source structure and permits sealing only after the replay-input gate is unlocked.

## Impact

- Affected packages: `@mosga/contracts`, `@mosga/session-readers`, and `@mosga/sanitizer`, plus a focused `@mosga/replay-bundle` foundation package and root workspace build/typecheck wiring.
- Existing `SanitizedSession`, dataset export, daemon review, and reconstructed direct-submit contracts remain available; later changes will explicitly integrate ReplayBundle with them.
- No source CLI is launched and no network request, proxy route, credential, full skill body, or original project tree is introduced by this change.
