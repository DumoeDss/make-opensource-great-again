## Why

The office-hours replay design requires Claude Code or Codex to assemble the
outbound request after resuming a reviewed native session, but the repository
currently has no safe way to materialize a sealed `ReplayBundle` or control a
source CLI process. The completed bundle foundation now provides the validated,
canonical input boundary this isolated runtime can consume without rereading or
mutating the original session or project.

## What Changes

- Add an isolated, short-lived replay workspace lifecycle that validates a
  sealed bundle before writing anything, stages canonical native-session bytes
  and exactly the sealed instruction snapshot, and cleans up after success,
  failure, cancellation, or timeout.
- Add a two-phase replay runtime API: preparation reports the observed CLI
  version and proxy-facing route requirements, then a one-use prepared handle
  accepts the separately rendered terminal input and an ephemeral local route
  binding for execution.
- Add capability-sensitive Claude Code and Codex runtime adapters that probe the
  installed CLI, select only an explicitly supported storage/invocation profile,
  and reject unknown or incompatible combinations instead of relying on one
  permanent command layout.
- Expose explicitly selected skill roots through isolated read-only snapshots
  according to the sealed `cli-discovery-read-only` policy, without adding skill
  bodies to the bundle or prompt.
- Add minimal child environments, bounded output draining, process-tree
  cancellation and timeout handling, idempotent cleanup, and a stable,
  disclosure-safe failure taxonomy.
- Add focused fake-CLI and fake-filesystem tests covering validation enforcement,
  exact staging, adapter selection, environment isolation, cancellation,
  timeout, cleanup, unsupported-version refusal, and non-disclosure.
- Do not create a proxy, hold real provider credentials, render terminal
  metadata, change submit orchestration/UI, resanitize content, or fall back to
  reconstructed API submission.

## Capabilities

### New Capabilities

- `replay-runtime`: Validated ReplayBundle preparation, isolated workspace and
  read-only skill exposure, controlled process lifecycle, cleanup, and safe
  runtime result/error contracts.
- `replay-cli-adapters`: Capability probing and fail-closed, version-sensitive
  Claude Code and Codex storage, invocation, environment, and local-route plans.

### Modified Capabilities

None.

## Impact

- Adds a focused `@mosga/replay-runtime` package depending on
  `@mosga/contracts` and `@mosga/replay-bundle`, plus root workspace
  build/typecheck ordering.
- Establishes the public runtime interfaces that the later proxy and integration
  children will consume; current `@mosga/direct-submit`, daemon routes, UI,
  provider-key storage, and reconstructed submission behavior remain unchanged.
- Adds child-process and temporary-filesystem implementation code, but no network
  listener, provider transport, credential store, sanitizer dependency, or
  production orchestration entry point.
