## ADDED Requirements

### Requirement: Source replay adapter registry is distinct and closed in v1

`@mosga/replay-runtime` SHALL contain an internal runtime-adapter registry keyed
by source CLI. V1 MUST register exactly Claude Code and Codex replay adapters.
Runtime adapters SHALL consume only the internal validated bundle value and
runtime-controlled paths; they SHALL NOT expose source-session discovery/capture,
sanitization, proxy serving, provider transport, or arbitrary command execution
through the public package surface.

#### Scenario: Validated source selects one runtime adapter

- **WHEN** a prepared validated bundle names `claude-code` or `codex`
- **THEN** exactly the corresponding runtime adapter handles probing, layout, and launch planning

#### Scenario: Unknown source is rejected

- **WHEN** runtime receives a bundle/source value with no registered v1 replay adapter
- **THEN** preparation returns `source-cli-unsupported` without probing an arbitrary executable or materializing session content

### Requirement: Capability probes are bounded and side-effect constrained

Each adapter SHALL define fixed version/help probe commands that run through the
runtime process supervisor with an absolute trusted executable, `shell: false`,
a minimal isolated probe environment, a short timeout, and capped/discarded
output. Probe parsing MUST produce source CLI, observed version, and capability
evidence without returning raw output. Probes SHALL NOT accept a prompt, resume a
session, write bundle content, use a route token, or contact a provider.

#### Scenario: Missing CLI is classified

- **WHEN** the trusted binary resolver cannot resolve the source executable
- **THEN** preparation returns `cli-not-found` before workspace materialization

#### Scenario: Hanging probe is bounded

- **WHEN** a fake CLI version/help probe never exits
- **THEN** runtime terminates it at the probe deadline, returns `cli-probe-failed`, and exposes no probe output

### Requirement: Profile selection requires version and capability evidence

An adapter profile SHALL bind a tested version predicate, required probe markers,
source session format, storage-layout id, invocation id, stdin support, isolated
home/config behavior, working-directory behavior, source wire protocol, route
configuration, telemetry/update suppressors, and non-interactive/approval
behavior. Selection MUST require every bound condition and MUST produce exactly
one profile. Runtime SHALL reject unknown versions, missing markers, incompatible
formats, or ambiguous matches instead of guessing, trying multiple invocations,
or using a nearest/latest profile.

#### Scenario: Supported evidence selects one profile

- **WHEN** fake probe output and the validated source format satisfy one complete tested profile
- **THEN** preparation records that profile id and uses only its storage and launch plan

#### Scenario: Version string alone is insufficient

- **WHEN** a fake CLI reports a version inside a profile range but omits a required resume, stdin, isolation, or route capability marker
- **THEN** preparation returns `cli-capability-unsupported` and does not launch a resume command

#### Scenario: Unknown newer version fails closed

- **WHEN** a fake CLI reports a newer version for which no complete profile is registered
- **THEN** preparation returns `cli-version-unsupported` instead of assuming backward compatibility

### Requirement: Adapter storage plans map but never transform validated content

Each selected adapter profile SHALL map every validated native logical file to a
safe CLI-recognized location under the isolated home and SHALL account for every
file exactly once. The profile MAY describe minimal derived CLI control
files/indexes containing only validated aliases, isolated paths, fixed adapter
values, and route environment-variable names. It MUST NOT transform canonical
native bytes, copy the original session/project, or place native body,
instruction content, terminal input, route token, or upstream credentials in a
derived control file.

#### Scenario: Complete file inventory is required

- **WHEN** a validated bundle contains a native file that the selected profile cannot map uniquely
- **THEN** preparation returns `session-layout-unsupported`, removes partial state, and does not launch the CLI

#### Scenario: Derived control files contain no user body

- **WHEN** a selected profile requires an index or local provider configuration
- **THEN** the generated file contains only allowed control values and no fake native, instruction, prompt, skill-body, or token canary

### Requirement: Claude Code replay plans are explicitly capability-sensitive

The Claude Code adapter SHALL accept only `claude-code-jsonl` and a selected
Claude profile that proves isolated home/config, native-session resume by the
validated session alias, headless single-prompt execution, terminal input from
stdin, deterministic isolated cwd, and Anthropic-compatible loopback routing.
Its launch plan SHALL use only that profile's tested static flags/layout and
SHALL NOT discover a live Claude home/project or try another command on failure.

#### Scenario: Supported Claude profile produces a safe plan

- **WHEN** a validated Claude bundle and complete fake Claude capability evidence match one profile
- **THEN** its canonical JSONL is mapped under the isolated Claude state, the command is headless resume, and the terminal input and token remain outside argv/control files

#### Scenario: Claude layout mismatch is refused

- **WHEN** the validated Claude artifact or observed capabilities cannot satisfy the profile's session-id/project-layout mapping
- **THEN** preparation returns `session-layout-unsupported` or `cli-capability-unsupported` without touching a live Claude home

### Requirement: Codex replay plans are explicitly capability-sensitive

The Codex adapter SHALL accept only `codex-jsonl` and a selected Codex profile
that proves isolated `CODEX_HOME`, rollout resume by the validated session alias,
non-interactive `exec resume`, terminal input from stdin, deterministic isolated
cwd, and OpenAI Responses-compatible local provider override. Its provider
configuration MUST reference an environment variable for the ephemeral route
token and MUST NOT embed the token or an upstream key on disk. It SHALL NOT rely
on `OPENAI_BASE_URL` alone unless a future tested profile explicitly proves that
complete behavior.

#### Scenario: Supported Codex profile produces a safe plan

- **WHEN** a validated Codex bundle and complete fake Codex capability evidence match one profile
- **THEN** its canonical rollout is mapped under isolated Codex state and its provider override points to the loopback route using token-by-environment

#### Scenario: Incomplete Codex provider support is refused

- **WHEN** a fake Codex version exposes `exec resume` but lacks the tested provider-config or stdin capability
- **THEN** preparation returns `cli-capability-unsupported` and does not fall back to a generic OpenAI environment or reconstructed API

### Requirement: Route requirements and bindings are protocol and target bound

The selected profile SHALL expose a non-secret `ReplayRouteRequirement`
containing source CLI, source wire protocol (`anthropic-messages` or
`openai-responses`), loopback transport, route-bearer auth scheme, and the sealed
target provider/model. Execution SHALL accept only a matching
`ReplayRouteBinding` with an HTTP loopback URL containing an explicit port,
nonempty route token, and CLI-facing model. It MUST reject remote hosts,
unsupported schemes, URL userinfo/fragments, source/protocol/auth mismatches, or
target provider/model mismatches before process launch.

#### Scenario: Matching local binding is injected

- **WHEN** the later proxy supplies a binding matching every prepared requirement
- **THEN** the adapter injects only the loopback route, CLI-facing model, and ephemeral token through its tested environment/config plan

#### Scenario: Remote or target-mismatched binding is refused

- **WHEN** a binding uses a non-loopback host or differs from the sealed provider/model/protocol
- **THEN** execution returns `route-binding-invalid`, launches no source CLI, and cleans the workspace

### Requirement: Adapter launch plans are static, stdin-driven, and secret-free

A selected adapter SHALL produce one launch plan with an absolute executable,
static profile flags, validated session alias, isolated cwd/home/config, bounded
stdin, and an allowlisted environment. The plan MUST NOT place terminal input,
route token, real credential, original path, native/instruction/skill body, or
raw probe output in argv or public diagnostics. Adapters SHALL NOT inspect model
responses, invoke tools themselves, or request another inference.

#### Scenario: Plan inspection reveals no sensitive values

- **WHEN** tests construct Claude and Codex launch plans with distinct fake prompt, token, path, and body canaries
- **THEN** none of those canaries appears in static argv, profile id, route requirement, safe observation, or generated non-secret control files

#### Scenario: Resume failure does not trigger another plan

- **WHEN** the source CLI rejects the selected resume invocation
- **THEN** runtime returns one stable execution failure and records exactly one resume-process launch

### Requirement: Adapter compatibility tests are fixture-driven and fail closed

Each enabled profile SHALL have captured fake version/help fixtures, near-miss
fixtures, canonical-layout fixtures, environment/argv snapshots with secret
redaction assertions, and an executable fake-CLI contract test. The matrix MUST
cover both supported and unsupported version/capability combinations and MUST
not invoke an installed source CLI or live network route.

#### Scenario: Profile matrix rejects every near miss

- **WHEN** each required marker, version predicate, session format, stdin feature, isolation feature, or provider-routing feature is removed or changed in turn
- **THEN** the corresponding fixture is rejected before resume launch

#### Scenario: Package surface does not expose adapter bypasses

- **WHEN** the built package's exports are inspected
- **THEN** consumers can access the high-level runtime and route/result types but cannot import a public raw materializer, arbitrary launch-plan executor, sanitizer, or source-session rereader
