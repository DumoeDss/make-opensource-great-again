## Context

The office-hours design defines request authenticity as a source Claude Code or
Codex CLI resuming a sanitized native session and assembling the request itself.
The completed bundle child now provides the fixed input boundary:

```text
validateReplayBundle(untrusted) -> ReplayBundlePayload
serializeNativeJsonl(file)      -> Uint8Array
serializeInstructionFile(file)  -> Uint8Array
```

Validation is self-contained and fail closed. The returned payload contains the
reviewed native rows, the exact instruction snapshot, fixed runtime/delivery
policy, and no original absolute session/project path, route token, provider
credential, generated system prompt, or skill body. Runtime must call that
validator itself before materialization; accepting a caller-asserted payload
would bypass the foundation's integrity boundary.

There is no suitable runtime host today. `@mosga/direct-submit` reconstructs and
sends provider requests directly, while `@mosga/publisher` has only a general
git/gh command runner with no cancellation, timeout, process-tree termination,
minimal environment, bounded output, or sensitive-data result contract. The
daemon owns current submission orchestration and provider keys, but this serial
child must not modify it. A focused package is therefore required between the
bundle foundation and the later proxy/integration children.

The runtime must also accommodate undocumented, changing CLI storage and command
details. The office-hours command sketches (`claude` headless resume and `codex
exec resume`) are directions, not permanent invocations. Compatibility must be
an explicit detected capability, not an optimistic version comparison or a
fallback command sequence.

## Goals / Non-Goals

**Goals:**

- Provide one public entry point that validates a sealed `ReplayBundle` before
  any bundle-derived bytes are written.
- Materialize a private, short-lived CLI home and workspace using only validated
  content and the bundle package's canonical serializers.
- Stage every sealed instruction file exactly once at its sealed `stagePath`,
  with no instruction discovery or broader project copy.
- Protect original skill roots by exposing detached, read-only snapshots under
  the sealed `cli-discovery-read-only` policy while leaving description/body
  loading to the source CLI.
- Detect the installed source CLI version and capabilities, then select an
  explicitly supported Claude Code or Codex storage/invocation profile.
- Give the proxy and integration children a two-phase, one-use runtime boundary:
  prepare first to observe CLI/version/protocol requirements, then execute with
  a separately rendered terminal input and ephemeral local route binding.
- Build a minimal child environment, pass the terminal input over stdin, bound
  all process output, support cancellation and timeout, terminate descendants,
  and clean the workspace on every terminal path.
- Return only stable, disclosure-safe observations and error codes.
- Prove the boundary with fake bundles, fake CLIs, fake skill roots, and injected
  platform/process dependencies; never read a developer's real CLI state.

**Non-Goals:**

- Registering, serving, converting, hashing, or enforcing the one-shot proxy.
- Holding or resolving a real upstream provider credential.
- Rendering or interpreting the terminal MOSGA metadata message.
- Validating consent or changing submit daemon/UI orchestration.
- Rescanning, resanitizing, rewriting, truncating, or summarizing session,
  instruction, prompt, skill, or response content.
- Falling back to the existing reconstructed API path.
- Reproducing an historical CLI build or supporting an unrecognized CLI/version
  combination.
- Providing a general-purpose container, VM, firewall, or arbitrary command
  runner. Isolation here is a purpose-built private home/workspace and controlled
  source-CLI process boundary.

## Decisions

### 1. Add a focused `@mosga/replay-runtime` package

The package depends only on `@mosga/contracts` and `@mosga/replay-bundle`.
It deliberately has no dependency on `@mosga/sanitizer`,
`@mosga/direct-submit`, the daemon, provider storage, or omnicross conversion.

Proposed internal layout:

```text
packages/replay-runtime/src/
├─ index.ts                 public surface only
├─ runtime.ts               validation and prepared-handle state machine
├─ errors.ts                stable safe failure/result model
├─ workspace.ts             private-root creation and exact staging
├─ skills.ts                bounded detached skill snapshots
├─ processSupervisor.ts     spawn, drain, cancel, timeout, tree termination
├─ environment.ts           platform and adapter environment allowlists
└─ adapters/
   ├─ types.ts              internal adapter/profile contracts
   ├─ registry.ts           Claude/Codex lookup
   ├─ capabilityProbe.ts    bounded version/help evidence
   ├─ claudeCode.ts         Claude storage and launch profiles
   └─ codex.ts              Codex storage and launch profiles
```

Source-session readers remain read-only capture adapters. Runtime adapters are a
different concern and stay inside the new package so no one can mistake
`CliSourceAdapter.captureNativeSession` for authority to reread an original
session during replay.

Alternative considered: place process execution in `@mosga/direct-submit` or
the daemon. Rejected because this child is intentionally usable by the later
proxy/integration slices without importing legacy request reconstruction,
provider credentials, HTTP routes, or UI state.

### 2. Export a two-phase runtime with an opaque, one-use prepared handle

Preparation must happen before terminal rendering because the final manifest
needs the runtime-observed CLI version. It must also happen before proxy route
registration because the proxy needs the source wire protocol and adapter
requirements. The public surface will be:

```ts
export interface ReplayRuntime {
  prepare(input: PrepareReplayInput): Promise<ReplayPrepareResult>;
}

export interface PrepareReplayInput {
  bundle: unknown;
  skillRoots?: readonly ReplaySkillRoot[];
  signal?: AbortSignal;
}

export type ReplayPrepareResult =
  | { ok: true; prepared: PreparedReplay }
  | { ok: false; error: ReplayRuntimeFailure };

export interface PreparedReplay {
  readonly observation: ReplayPreparationObservation;
  execute(input: ExecutePreparedReplayInput): Promise<ReplayExecutionResult>;
  dispose(): Promise<ReplayCleanupResult>;
}

export interface ExecutePreparedReplayInput {
  terminalInput: string;
  route: ReplayRouteBinding;
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

`ReplayPreparationObservation` contains only:

- source CLI;
- validated bundle content hash;
- recorded CLI version from the bundle;
- runtime-observed replay CLI version;
- selected capability-profile id;
- sealed delivery target;
- the proxy-facing `ReplayRouteRequirement`.

It exposes no workspace path, command, argument list, environment, skill path,
session body, terminal input, or token. `PreparedReplay` is stateful and opaque:
`execute` may be called once; a second call returns
`prepared-replay-consumed`. `dispose` is idempotent, aborts any active process,
and cleans the root. Preparation or execution cancellation also consumes the
handle.

`createReplayRuntime(options?)` accepts only trusted process configuration such
as source CLI binary overrides, a dedicated temp base, probe/execution limits,
and termination grace. These options are process configuration, not request
body fields. Filesystem/process dependency injection remains an internal test
seam rather than a broad public command-execution API.

Alternative considered: a single `executeReplay` call. Rejected because it
would force integration to render the manifest and register a route before it
knows the observed CLI version/profile. A public low-level
`materializeValidatedPayload` is also rejected because callers could bypass
bundle validation.

### 3. Brand validated inputs internally and validate before side effects

`ReplayRuntime.prepare` performs this order:

1. Call `validateReplayBundle(input.bundle)`.
2. Strict-parse the now-validated bundle only to retain its trusted
   `integrity.contentHash`.
3. Validate runtime aliases, fixed v1 policies, source CLI, and requested skill
   descriptors.
4. Resolve a trusted absolute CLI executable and run bounded capability probes.
5. Select one supported adapter profile.
6. Only then create the replay root and materialize content.

An internal non-exported symbol brands the validated payload/hash pair.
Workspace and adapter functions accept only that branded value. This is
defense-in-depth against accidentally wiring an untrusted `ReplayBundlePayload`
directly into a file writer.

`@mosga/replay-runtime` imports no sanitizer API. It never accepts a
`ReplayBundleDraft`, review report, mapper, `SanitizedSession`, source session
reference, or source project path.

Alternative considered: type the public input as `ReplayBundle` and trust the
caller. Rejected because TypeScript types do not validate runtime data and later
children must not be able to bypass the seal accidentally.

### 4. Use data-driven, capability-sensitive adapter profiles

Each internal source adapter owns a table of explicit profiles. A profile binds:

- a source CLI and tested version predicate;
- required bounded probe evidence;
- a storage-layout id and native-file placement mapper;
- an invocation id and static argument builder;
- isolated home/config locations;
- stdin terminal-input support;
- working-directory behavior;
- source wire protocol and route configuration shape;
- telemetry/update suppression known for that profile;
- non-interactive/approval behavior required to avoid an agent loop.

The probe supervisor resolves the absolute binary and runs only fixed
version/help commands with `shell: false`, a minimal probe environment, a short
timeout, and capped output. Probe output is parsed in memory and discarded.
Selection requires both a supported version predicate and every required
capability marker. An unknown version, missing marker, ambiguous result, or
unsupported session format/layout fails before session staging or launch. There
is no "try the latest-looking command" path.

The initial plans have these conceptual shapes:

```text
Claude Code
  isolated Claude config/home
  canonical Claude JSONL at the profile's resume storage location
  headless/print + resume by validated session alias
  terminal input over stdin
  Anthropic-compatible loopback route binding

Codex
  isolated CODEX_HOME
  canonical rollout JSONL at the profile's resume storage location
  exec resume by validated session alias
  terminal input over stdin
  generated local provider config + OpenAI Responses loopback route binding
```

Exact flags, filename rules, indexes, and config keys are profile data proven by
captured fake probe fixtures and fake-CLI layout tests. The implementation will
enable only profiles whose entire combination is verified; it will not infer
support merely because `--version` parses.

The profile's launch plan may generate minimal runtime control files needed by
the CLI (for example, an index or provider override), but those files may contain
only validated aliases, isolated paths, fixed adapter values, and references to
environment variable names. They may not contain native row bodies, instruction
content, terminal input, real provider credentials, or the route token.

Alternative considered: hard-code the office-hours command sketches for all
versions, or sequentially try several flag combinations. Rejected because both
can mutate CLI state or send a request before discovering incompatibility.

### 5. Materialize canonical content once into a private, non-aliasing workspace

Every preparation creates a random directory under a dedicated MOSGA temp
namespace. The root and sensitive subdirectories use owner-only permissions
where the platform supports them:

```text
<temp>/mosga-replay-<random>/
├─ cli-home/                  isolated CLI state
├─ workspace/...             sealed instruction stage paths
├─ skills/                    detached snapshots selected by policy
├─ runtime/                   non-secret adapter control files
└─ .mosga-replay-owner.json   schema/id marker for safe stale cleanup
```

All path creation uses resolved containment checks, no-follow file operations,
exclusive creation, and deterministic collision rejection. Unsafe
`projectAlias`/`workingDirectoryAlias` values, symlinks/reparse points, special
files, or overlapping destinations fail closed. The runtime never changes the
process working directory to, or creates a link to, the original project.

For every native file, runtime calls `serializeNativeJsonl` exactly once and
writes those bytes to the destination selected by the supported profile.
Adapters choose placement but cannot rewrite bytes. Native copies may be
writable by the source CLI because resume can append state; the copy is
disposable and never flows back to the bundle or source.

For every instruction file, runtime calls `serializeInstructionFile` exactly
once and writes those bytes at `<root>/<sealed stagePath>`. All and only snapshot
entries must be accounted for, and they are made read-only after write. Runtime
does not walk parent directories for `CLAUDE.md`/`AGENTS.md`, does not infer a
new scope, and does not read the original project.

Generated adapter control files are segregated under runtime/CLI-home paths and
are not user content. A pre-launch inventory verifies that every native and
instruction input has exactly one allowed destination, no additional
session/project content exists, and all paths remain inside the root.

Alternative considered: let each adapter serialize and copy arbitrary source
paths. Rejected because it would duplicate canonicalization, reopen traversal
and reread risks, and make exact instruction staging unprovable.

### 6. Expose skills as bounded detached read-only snapshots

`ReplaySkillRoot` is a trusted process-only descriptor:

```ts
export interface ReplaySkillRoot {
  id: string;                 // safe alias, not an original path
  sourcePath: string;         // private absolute path
  scope: "user" | "project";
  precedence: number;
}
```

An empty list is valid. For each explicitly selected root, runtime creates a
detached snapshot under the replay root and maps it to the profile's native
skill discovery location. It never places skill content in the `ReplayBundle`,
terminal input, argv, environment, result, or logs. The copier:

- accepts regular files/directories only;
- rejects symlinks, junctions/reparse points, devices, sockets, and path escape;
- applies file-count, per-file, and total-byte limits;
- rejects deterministic merge collisions rather than overwriting by accident;
- preserves only required read/execute bits and removes write bits after copy;
- never includes the original source path in a generated config or result.

The non-aliasing snapshot is the hard safety guarantee: even if a same-user
process can weaken local permission bits, it can alter only the disposable
copy, never the original skill root. The CLI still performs its own discovery
and decides whether to read a `SKILL.md` body; runtime does not parse or inject
descriptions/bodies. Fake-CLI tests use separate description/body canaries to
prove the runtime passes neither through argv, stdin, environment, control
files, nor public results.

Alternative considered: symlink the user's live skill root. Rejected because a
symlink is not a read-only boundary and would allow a resumed process to mutate
real files. Omitting skills entirely is also rejected because it changes the
CLI-generated initial context contrary to the sealed policy.

### 7. Make the proxy boundary typed, local-only, target-bound, and secret-safe

Preparation exposes a non-secret `ReplayRouteRequirement`:

```ts
export interface ReplayRouteRequirement {
  sourceCli: "claude-code" | "codex";
  wireProtocol: "anthropic-messages" | "openai-responses";
  transport: "loopback-http";
  authScheme: "route-bearer";
  targetProviderId: string;
  targetModel: string;
}

export interface ReplayRouteBinding extends ReplayRouteRequirement {
  baseUrl: string;
  routeToken: string;
  cliModel: string;
}
```

The later proxy child creates the binding. Runtime validates exact equality with
the prepared source/protocol/sealed delivery target, requires a nonempty
short-lived token, and accepts only an HTTP loopback host with an explicit port.
It rejects remote hosts, userinfo, fragments, unsupported schemes, target
mismatches, and cross-source bindings.

The route token is placed only in the child environment. For Codex, generated
provider config references the environment variable name rather than embedding
the token on disk. No real upstream key is accepted anywhere in the runtime
API. Static command arguments never contain a token or terminal input.

The child environment is built from an explicit platform allowlist plus
adapter-controlled values. It redirects HOME/USERPROFILE, XDG/config/cache/temp,
and CLI-specific state into the replay root; sets a deterministic cwd; and does
not spread `process.env`. Only narrowly required locale/platform variables, the
resolved executable path requirements, telemetry/update suppressors, and route
variables are included. Secret-bearing maps are never stringified or returned.

Alternative considered: accept arbitrary caller-provided environment variables
or a complete command plan. Rejected because later code could accidentally pass
real provider credentials, original paths, or prompt content and bypass adapter
validation.

### 8. Send exactly one terminal input over stdin

`execute` accepts one nonempty, valid Unicode, size-bounded `terminalInput`. The
runtime does not render, parse, scan, log, hash, persist, retry, or modify it.
The selected capability profile must support consuming the prompt from stdin;
versions that require prompt text in argv or a persisted prompt file are
unsupported. The launch plan combines only static adapter flags and the
validated session alias with the terminal bytes on stdin.

This avoids prompt exposure through command-line logging/process listings and
keeps terminal rendering in the later integration child. The runtime does not
append the provider response to the bundle or original session; any CLI writes
remain in the disposable native copy.

Alternative considered: put the terminal message in argv as shown by conceptual
CLI examples. Rejected because argv is routinely observable and logged by
process tooling.

### 9. Supervise the complete process tree with first-wins termination

The process supervisor always uses the resolved absolute executable,
`shell: false`, the isolated cwd, the minimal environment, and piped stdio.
stdout/stderr are continuously drained to avoid deadlock but never returned or
logged. Per-stream and combined byte limits are enforced while draining; excess
output terminates the tree with `process-output-limit`.

The state machine is:

```text
prepared -> starting -> running -> terminating -> exited -> cleaning -> done
        \-> disposed/cancelled --------------------------^
```

- A pre-aborted signal prevents spawn and initiates cleanup.
- Caller cancellation and deadline timeout race through one first-wins
  termination latch, producing `cancelled` or `timed-out`.
- Termination first requests graceful tree shutdown, waits a bounded grace
  period, then force-kills the tree and waits for close.
- POSIX launches in a dedicated process group and signals the group. Windows
  uses the platform tree-termination strategy rather than killing only the
  direct wrapper process.
- Listeners, timers, stdin, and streams are closed on every path.
- A nonzero exit without an earlier lifecycle cause is
  `process-exit-failed`; raw stderr never becomes an error message.
- Runtime never retries, launches a second adapter plan, or calls reconstructed
  submit.

Cleanup runs in `finally` after success, adapter refusal, spawn error,
cancellation, timeout, output overflow, or nonzero exit. Cleanup retries only
filesystem deletion with a small bounded backoff; it never retries inference.
A cleanup failure changes an otherwise successful result into `cleanup-failed`.

A schema-marked stale-root janitor may remove only this package's dedicated,
marker-bearing roots older than a configured threshold. It resolves every
candidate under the dedicated temp base before deletion and never follows links.
This limits sanitized residue after a hard process crash without risking
unrelated temp data.

Alternative considered: reuse `@mosga/publisher`'s `AsyncCommandRunner`.
Rejected because it accumulates and returns raw output, inherits the caller's
environment, and does not control timeouts, cancellation, descendants, or
workspace cleanup.

### 10. Return a closed, disclosure-safe error/result contract

Public operations return discriminated results instead of arbitrary subprocess
exceptions. `ReplayRuntimeFailure` contains only:

```ts
interface ReplayRuntimeFailure {
  code: ReplayRuntimeErrorCode;
  stage: ReplayRuntimeStage;
  sourceCli: "claude-code" | "codex" | null;
  replayCliVersion: string | null;
  cleanup: "not-created" | "complete" | "failed";
}
```

Stable v1 codes are:

```text
bundle-invalid
runtime-policy-unsupported
source-cli-unsupported
cli-not-found
cli-probe-failed
cli-version-unsupported
cli-capability-unsupported
session-layout-unsupported
workspace-create-failed
workspace-materialize-failed
instruction-stage-failed
skill-root-invalid
skill-exposure-failed
prepared-replay-consumed
route-binding-invalid
terminal-input-invalid
process-spawn-failed
process-exit-failed
process-output-limit
cancelled
timed-out
cleanup-failed
```

Stages are `validate`, `probe`, `materialize`, `launch`, `run`, `terminate`, and
`cleanup`. Success contains the safe preparation observation, start/finish
timestamps, duration, and exit status only. It contains no raw stdout/stderr,
prompt, route token, environment, real path, generated config, native body, or
skill content. Internal causes may be inspected in tests but are not enumerable
public output and are never logged by the package.

Alternative considered: return a raw `Error`, command result, or diagnostic
tail. Rejected because CLIs can echo prompts, configuration, paths, or native
session content on failures.

### 11. Test the child boundary without real sessions, credentials, or CLIs

Focused tests live in `@mosga/replay-runtime` and use:

- sealed fake ReplayBundles produced by the foundation helpers;
- fake Claude/Codex probe transcripts for every enabled/near-miss profile;
- small executable fake CLIs that inspect their isolated layout and record only
  boolean/hash assertions, never fixture bodies;
- fake instruction and skill description/body canaries;
- injected clock, filesystem, binary locator, process host, and termination
  hooks for deterministic lifecycle races.

Tests cover validation-before-write, canonical byte equality, exact instruction
inventory, no source reread/write, alias/path containment, skill snapshot
non-aliasing, symlink/special-file refusal, minimal environment allowlists,
loopback/target route binding, stdin-only terminal input, one-use handles,
missing/unknown/ambiguous CLI profiles, spawn and nonzero-exit mapping, output
caps, cancel/timeout races, descendant termination, cleanup on every exit, stale
root cleanup, and package-surface/no-sanitizer/no-proxy boundary checks.

No test invokes an installed `claude` or `codex`, reads `~/.claude`,
`~/.codex`, a real project instruction, a real skill root, a provider key, or a
live network endpoint.

## Risks / Trade-offs

- **[CLI storage or flags change without a stable machine-readable capability
  API]** → Require version plus probe evidence and an explicitly tested profile;
  reject unknown/ambiguous combinations before materialization or launch.
- **[A same-user child weakens read-only permission bits]** → Never alias the
  original project/session/skill roots; only disposable skill snapshots are
  visible, so source mutation remains impossible through the staged path.
- **[CLI output echoes sensitive runtime content]** → Drain in memory, cap it,
  discard it, and expose only stable classification fields.
- **[A child leaves descendants after cancellation]** → Launch a dedicated
  process group/tree, test platform termination paths, wait after graceful and
  forced termination, and fail cleanup closed.
- **[Cancellation, timeout, exit, and cleanup race]** → Serialize state changes
  behind one first-wins latch and one idempotent finalizer.
- **[A hard host crash leaves sanitized data in temp]** → Owner-only random
  roots, no original credentials, marker-scoped stale cleanup, and no retained
  output/session writeback.
- **[Snapshotting a large skill tree is expensive]** → Explicit root selection,
  deterministic file/byte limits, bounded copy, and fail-closed refusal rather
  than partial discovery.
- **[Minimal environments break a CLI that assumes inherited state]** → Make
  required variables part of each tested capability profile; never fix a
  failure by inheriting the complete parent environment.
- **[Workspace isolation is mistaken for a full OS sandbox]** → Keep the public
  contract narrow, use non-aliasing data roots and non-interactive profiles, and
  document that network/firewall/container isolation is not supplied by this
  child.

## Migration Plan

1. Add `@mosga/replay-runtime` with its public types/error contract and root
   build/typecheck ordering after `@mosga/replay-bundle`.
2. Implement internal validation branding, adapter capability profiles, exact
   materialization, skill snapshots, environment construction, and process
   supervision.
3. Enable initial Claude Code and Codex profiles only after their captured probe
   fixtures and fake-CLI storage/invocation tests pass.
4. Run package-surface, focused lifecycle/security tests, then repository-wide
   typecheck, test, and build gates.
5. Leave the package unused by production daemon/UI submission in this child.
   The proxy child imports only route requirement/binding contracts; the
   integration child owns prepare/render/register/execute/dispose orchestration.

Rollback is additive: remove the unused package and root build wiring. No current
session, review, provider, receipt, daemon route, or direct-submit format is
migrated.

## Open Questions

- The exact initially enabled CLI version ranges, probe markers, storage paths,
  and static flags must be fixed from implementation-time compatibility
  fixtures. Until a complete profile is verified, that combination remains
  unsupported; this is not permission to add a heuristic fallback.
- If a future CLI cannot accept the terminal input over stdin or cannot isolate
  its home/config without inheriting user state, support requires a new explicit
  profile or schema/version decision rather than weakening the v1 boundary.
