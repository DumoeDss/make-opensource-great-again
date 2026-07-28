# replay-runtime Specification

## Purpose
TBD - created by archiving change api-direct-submit-cli-replay-runtime. Update Purpose after archive.
## Requirements
### Requirement: Replay preparation validates a sealed bundle before side effects

`@mosga/replay-runtime` SHALL expose a high-level preparation API whose bundle
input is `unknown`. Preparation MUST call `validateReplayBundle` before creating
a replay workspace or writing bundle-derived content, and internal
materialization APIs MUST accept only a non-public validated/brand-bearing value.
The runtime SHALL NOT accept a `ReplayBundleDraft`, review report, mapper,
`SanitizedSession`, original session reference, or caller-asserted
`ReplayBundlePayload` as an execution input.

#### Scenario: Valid sealed bundle can be prepared

- **WHEN** preparation receives an intact sealed ReplayBundle for a supported source CLI
- **THEN** runtime validates it and may proceed to capability detection and isolated materialization

#### Scenario: Mutated bundle produces no workspace

- **WHEN** preparation receives a bundle whose native row, instruction, policy, entry manifest, or root hash no longer validates
- **THEN** it returns `bundle-invalid` before creating a bundle-derived workspace or launching a process

### Requirement: Runtime uses a two-phase one-use prepared handle

The runtime SHALL return an opaque `PreparedReplay` only after validation,
capability detection, and materialization succeed. Its public observation SHALL
contain only source CLI, validated bundle content hash, recorded CLI version,
runtime-observed replay CLI version, selected capability-profile id, sealed
delivery target, and non-secret route requirements. The handle SHALL accept a
separately rendered terminal input and route binding only during `execute`,
SHALL permit at most one execution attempt, and SHALL provide idempotent
`dispose`.

#### Scenario: Preparation supplies data needed by later children

- **WHEN** a supported bundle is prepared successfully
- **THEN** integration can read the replay CLI version and the proxy can read route requirements without receiving a workspace path, prompt, token, command, environment, or native body

#### Scenario: Prepared replay cannot execute twice

- **WHEN** `execute` is called after the prepared handle has already begun or completed an execution attempt
- **THEN** runtime refuses with `prepared-replay-consumed` and does not launch another process

#### Scenario: Dispose is idempotent

- **WHEN** `dispose` is called multiple times before or after execution
- **THEN** every call completes safely, no additional process is launched, and the replay root is absent

### Requirement: Canonical native session materialization

For every validated native file, runtime MUST obtain staged content only by
calling `serializeNativeJsonl` and MUST place the exact returned bytes at the
destination selected by the supported source-CLI profile. Adapters MAY choose
version-specific placement but MUST NOT alter, filter, reorder, augment, or
reserialize native rows. Staged native files MAY be writable only inside the
disposable replay root so the CLI can append runtime state; writes SHALL never
flow back to the bundle or original session.

#### Scenario: Canonical bytes reach the CLI layout

- **WHEN** a validated native file is materialized for a supported profile
- **THEN** the bytes at the profile destination are byte-equal to `serializeNativeJsonl(file)`

#### Scenario: Source session is never consulted

- **WHEN** preparation and execution complete after the original transcript has been removed or made unreadable
- **THEN** replay uses only the validated bundle and succeeds or fails independently without reading or modifying the original path

### Requirement: Exact sealed instruction snapshot staging

Runtime MUST call `serializeInstructionFile` for every validated instruction
snapshot entry and stage all and only those bytes at the sealed relative
`stagePath` under the replay root. It MUST verify path containment and
destination uniqueness, make the staged instruction copy read-only, and refuse
any unsafe or overlapping layout. Runtime SHALL NOT discover, search for,
inherit, merge, or reread `CLAUDE.md` or `AGENTS.md` from the original project,
CLI home, parent directories, or process environment.

#### Scenario: Complete snapshot is staged exactly once

- **WHEN** a bundle contains an ordered set of sealed `CLAUDE.md` and `AGENTS.md` entries
- **THEN** every entry exists once at its sealed stage path with byte-equal canonical content and no additional discovered instruction file

#### Scenario: Missing sealed instruction fails closed

- **WHEN** a filesystem error prevents one sealed instruction from being written or made read-only
- **THEN** preparation returns `instruction-stage-failed`, cleans the partial root, and does not launch the CLI

### Requirement: Private non-aliasing replay workspace

Each preparation SHALL use a random owner-private root inside a dedicated MOSGA
temporary namespace, with isolated CLI home/config/cache/temp and a deterministic
working directory inside that root. All creation and deletion MUST use resolved
containment checks and no-follow semantics. The runtime SHALL NOT mount, copy,
link to, set cwd to, or expose an environment reference to the original project
or original session. Bundle aliases and every derived destination MUST be
validated as safe before use.

#### Scenario: Runtime writes stay isolated

- **WHEN** a fake CLI appends to its staged session and creates files in its home and cwd
- **THEN** all writes remain below the replay root and the original session and project fixtures are byte-unchanged

#### Scenario: Unsafe runtime alias is refused

- **WHEN** a validated payload contains an alias that would resolve absolute, traverse, or escape the replay root
- **THEN** preparation returns `runtime-policy-unsupported` or `session-layout-unsupported` before materializing content

### Requirement: Skill roots are detached and exposed read-only by policy

Under v1 `cli-discovery-read-only`, runtime SHALL accept only explicitly selected
trusted `ReplaySkillRoot` descriptors and expose them through bounded detached
snapshots at the selected CLI profile's discovery locations. It MUST reject
symlinks, junctions/reparse points, special files, traversal, collisions, and
configured file/byte-limit overflow. Snapshot files SHALL have write bits
removed, original roots SHALL never be aliased, and runtime SHALL NOT parse or
inject skill descriptions or bodies into argv, stdin, environment, generated
control files, or public results.

#### Scenario: CLI discovers a copied skill without source mutation

- **WHEN** a fake skill root is explicitly supplied and a fake CLI reads it from its native discovery location
- **THEN** the CLI sees the detached snapshot while writes cannot affect the original root

#### Scenario: Skill symlink fails closed

- **WHEN** an explicitly supplied skill tree contains a symlink or reparse point to content outside the tree
- **THEN** preparation returns `skill-exposure-failed`, cleans the partial snapshot, and exposes no escaped content

#### Scenario: Skill body is not pre-injected

- **WHEN** a fake skill contains distinct description and body canaries
- **THEN** neither canary appears in runtime argv, terminal stdin, environment, control files, errors, or observations, leaving body loading to the CLI

### Requirement: Terminal input is bounded and stdin-only

`PreparedReplay.execute` SHALL accept exactly one nonempty valid Unicode terminal
input within a fixed size limit. Runtime MUST pass its exact UTF-8 bytes through
stdin only and MUST NOT place it in argv, an environment variable, a generated
file, a log, a hash, or a public result. Runtime SHALL NOT parse, scan, rewrite,
retry, or append a response to that input.

#### Scenario: Exact terminal bytes use stdin

- **WHEN** execution receives a valid terminal input
- **THEN** the fake CLI receives the exact UTF-8 bytes once on stdin and its argv and environment contain no terminal substring

#### Scenario: Invalid terminal input prevents launch

- **WHEN** terminal input is empty, contains an unpaired surrogate or NUL, or exceeds the configured bound
- **THEN** execution returns `terminal-input-invalid`, launches no CLI, and cleans the workspace

### Requirement: Minimal non-inheriting child environment

Runtime SHALL build the source CLI environment from an explicit
platform/profile allowlist and SHALL NOT spread the parent `process.env`. It
MUST redirect home, config, state, cache, and temp variables into the replay
root; use the isolated working directory; include only narrowly required
platform/locale variables, profile-tested telemetry/update suppressors, and
ephemeral local-route variables; and MUST NOT accept or expose a real upstream
provider credential.

#### Scenario: Parent secret variables are absent

- **WHEN** the parent process contains fake provider-key and unrelated secret environment canaries
- **THEN** a fake CLI receives neither canary while required isolated-home and route variables remain available

#### Scenario: Real provider credentials are not representable

- **WHEN** a caller attempts to add an arbitrary credential-bearing environment field to runtime input
- **THEN** the strict public/runtime contract rejects or ignores the unknown field rather than forwarding it

### Requirement: Controlled process and process-tree lifecycle

The process supervisor MUST launch the resolved absolute CLI executable with
`shell: false`, the isolated cwd/environment, piped stdin/stdout/stderr, and a
platform process-tree boundary. It SHALL continuously drain output without
returning it, enforce per-stream and combined byte limits, classify nonzero
exit, and close every timer/listener/stream. Runtime MUST NOT launch a second
command profile or reconstructed API path after any failure.

#### Scenario: Successful process is cleaned

- **WHEN** the fake CLI consumes stdin and exits zero within limits
- **THEN** execution reports only safe timing/exit observations and removes the entire replay root

#### Scenario: Output overflow terminates the tree

- **WHEN** a fake CLI or descendant exceeds the configured output limit
- **THEN** runtime terminates the process tree, returns `process-output-limit`, discards all output bytes, and cleans the root

#### Scenario: Nonzero exit is disclosure-safe

- **WHEN** a fake CLI writes prompt, token, path, and native-body canaries to stderr before exiting nonzero
- **THEN** runtime returns `process-exit-failed` without any canary in the error, result, or logs

### Requirement: Cancellation and timeout terminate descendants and clean state

Preparation and execution SHALL accept `AbortSignal`; execution SHALL enforce a
bounded deadline. A pre-aborted signal MUST prevent launch. After spawn,
cancellation and timeout MUST race through one first-wins termination latch,
request graceful process-tree shutdown, escalate to forced shutdown after a
bounded grace, wait for close, and run idempotent cleanup.

#### Scenario: Caller cancellation wins

- **WHEN** the caller aborts while a fake CLI and descendant are running before the deadline
- **THEN** runtime terminates both, returns `cancelled`, and removes the replay root

#### Scenario: Deadline wins

- **WHEN** a fake CLI remains running beyond the execution timeout without caller cancellation
- **THEN** runtime terminates its process tree, returns `timed-out`, and removes the replay root

#### Scenario: Pre-aborted execution never spawns

- **WHEN** execution receives an already aborted signal
- **THEN** runtime returns `cancelled`, performs cleanup, and records no child-process launch

### Requirement: Cleanup is mandatory and stale cleanup is narrowly scoped

Runtime SHALL clean partial or complete replay roots after validation-adjacent
materialization failure, preparation cancellation, dispose, successful
execution, spawn failure, nonzero exit, output overflow, cancellation, and
timeout. A cleanup failure MUST be represented as `cleanup-failed`, including
when process execution otherwise succeeded. Best-effort stale cleanup MAY remove
only old roots below the dedicated temp namespace that contain a valid
runtime-owned marker; it MUST resolve containment and refuse links or unrelated
directories.

#### Scenario: Partial preparation is removed

- **WHEN** materialization fails after one native or instruction file has been written
- **THEN** runtime removes the partial marker-bearing root before returning the failure

#### Scenario: Unrelated temp directory survives stale cleanup

- **WHEN** the temp base contains an old directory without a valid MOSGA replay owner marker
- **THEN** the stale janitor leaves that directory unchanged

### Requirement: Stable disclosure-safe runtime outcomes

All public runtime failures SHALL use the closed v1 code set and stages defined
by the design. A failure SHALL contain only code, stage, nullable source CLI,
nullable replay CLI version, and cleanup state. Public success SHALL contain
only the safe preparation observation plus timestamps, duration, and exit
status. No public or logged value SHALL include raw stdout/stderr, exception
messages, prompts, route tokens, real credentials, commands, environments,
absolute source/workspace/skill paths, native session bodies, instruction
content, skill content, or provider responses.

#### Scenario: Every injected failure maps stably

- **WHEN** tests inject each validation, probe, materialization, route, spawn, run, termination, and cleanup failure category
- **THEN** each result uses its documented stable code/stage and contains no raw cause detail

#### Scenario: No fallback is observable

- **WHEN** preparation or execution returns any failure
- **THEN** no network transport, sanitizer API, current direct-submit function, or alternate reconstructed request path is invoked

### Requirement: Runtime tests use fake data and fake CLIs only

Focused tests SHALL use hand-crafted sealed ReplayBundles, fake instruction and
skill roots, captured fake capability output, and fake executable CLIs or
injected process/filesystem hosts. Tests MUST NOT invoke an installed Claude
Code or Codex binary, read a real CLI home/session/project/instruction/skill
root, use a real route token/provider credential, or contact a network endpoint.

#### Scenario: Test suite is hermetic

- **WHEN** the replay-runtime test suite runs on a machine with or without source CLIs and user sessions installed
- **THEN** results are identical and every filesystem/process/network input comes from the test fixture or injected fake

