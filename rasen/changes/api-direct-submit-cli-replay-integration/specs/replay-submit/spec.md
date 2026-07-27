## ADDED Requirements

### Requirement: cli-resume orchestration follows the locked prepare-render-register-execute-dispose order

`@mosga/replay-submit` SHALL expose a single public `submitCliResume` function
that drives the locked sequence: validate bundle and consent, call
`runtime.prepare`, render the terminal manifest, call `proxy.registerRoute`,
call `prepared.execute`, await the proxy receipt, merge the extended receipt,
and dispose both the prepared replay and the proxy route. The function SHALL
dispose in a `finally` block on every path including success, failure,
cancellation, and timeout. It SHALL accept injectable `ReplayRuntime` and
`ReplayProxy` instances so tests never launch a real CLI, bind a real listener,
or contact a real provider.

#### Scenario: Successful round-trip produces a receipt

- **WHEN** a valid sealed bundle and matching consent are submitted with a fake runtime and proxy that report success
- **THEN** the orchestration returns `ok: true` with a `CliResumeReceipt` carrying all three hashes and disposes both the prepared replay and the proxy route

#### Scenario: Runtime failure disposes cleanly and does not fall back

- **WHEN** `runtime.prepare` or `prepared.execute` returns `ok: false`
- **THEN** the orchestration returns `ok: false` with a stable failure code, disposes any prepared replay and proxy route, and never invokes a reconstructed-API submission path

#### Scenario: Dispose runs on every exit path

- **WHEN** the orchestration completes, fails, is cancelled, or times out
- **THEN** `prepared.dispose` and `handle.dispose` are each called exactly once regardless of which step succeeded or failed

### Requirement: Terminal manifest is rendered deterministically from sealed-bundle inputs only

The orchestration SHALL render the sole terminal user message by combining
the bundle's sealed `TerminalManifestSeed`, the bundle's reviewed omissions,
the review-evidence `humanReviewPassed` flag, the runtime-observed
`replayCliVersion`, the validated `bundleContentHash`, and a consent
acknowledgment subset. The renderer SHALL be a pure function that produces
byte-identical output for identical inputs using canonical JSON key order and
LF line endings. It SHALL NOT read the original session file, recompute
trajectory counts, discover instruction files, add source-model information not
present in the seed, or enrich the manifest with any data outside its explicit
inputs.

#### Scenario: Identical inputs produce identical output

- **WHEN** the renderer is called twice with the same seed, omissions, hash, CLI version, and consent
- **THEN** both calls return byte-identical strings

#### Scenario: Manifest discloses the replay CLI version and bundle hash

- **WHEN** a terminal manifest is rendered from a preparation observation
- **THEN** the JSON block contains the runtime-observed `replayCliVersion` alongside the seed's `recordedCliVersion`, and the `bundleContentHash` in the sanitization section

#### Scenario: Manifest carries reviewed omissions

- **WHEN** the bundle's omissions list contains entries
- **THEN** the terminal manifest's trajectory section discloses each omission's category and disclosure text

#### Scenario: Renderer does not reread raw session metadata

- **WHEN** the renderer is inspected or tested
- **THEN** it accepts only its explicit typed inputs and performs no filesystem, network, or session-file access

### Requirement: cli-resume consent binds the full policy surface and bundle hash

The orchestration SHALL require a `CliResumeConsent` record before any side
effect. The consent SHALL bind the validated bundle content hash
(`sha256:<lowercase-hex>`), target provider, target model, replay mode
(`cli-resume`), instruction policy (`sanitized-snapshot`), and skill policy
(`cli-discovery-read-only`). All three acknowledgments (`tosRiskAcknowledged`,
`fullRetentionAcknowledged`, `runtimeContextAcknowledged`) MUST be true. The
orchestration SHALL validate consent against the extracted bundle payload
before calling `runtime.prepare` and SHALL refuse when the bundle hash, target,
mode, or any policy field does not match the sealed values.

#### Scenario: Consent validated before expensive side effects

- **WHEN** consent is submitted with a bundle hash or target that does not match the sealed bundle
- **THEN** the orchestration returns `consent-invalid` without calling `runtime.prepare`, probing a CLI, or creating a workspace

#### Scenario: Missing runtime-context acknowledgment is refused

- **WHEN** consent has `runtimeContextAcknowledged: false`
- **THEN** the orchestration returns `consent-invalid` and performs no side effect

#### Scenario: Policy mismatch is refused

- **WHEN** consent's instruction or skill policy differs from the sealed runtime policy
- **THEN** the orchestration returns `consent-invalid`

### Requirement: Extended receipt converges bundle, CLI-request, and outbound-request hashes

The orchestration SHALL assemble a `CliResumeReceipt` that records three
distinct hashes: `bundleContentHash` (from the runtime preparation
observation), `cliRequestHash` (from the proxy receipt), and
`outboundRequestHash` (from the proxy receipt). The receipt SHALL also record
the converter id and version, upstream API format, HTTP status, outcome,
normalized usage, source and replay CLI versions, capability profile, timing,
and the accepted consent. The receipt SHALL NOT include the real API key, the
route token, full request or response bodies, system prompts, tool schemas,
the workspace path, or any CLI-generated content.

#### Scenario: All three hashes are distinct on a cross-protocol round-trip

- **WHEN** a Claude CLI sends an Anthropic Messages request that is converted to OpenAI Chat and forwarded successfully
- **THEN** the receipt records a `bundleContentHash` from the observation and distinct `cliRequestHash` / `outboundRequestHash` from the proxy receipt

#### Scenario: Runtime failure with completed round-trip records hashes

- **WHEN** the CLI sends the request successfully but exits non-zero
- **THEN** the receipt records `outcome: 'runtime-failed'` alongside the real hashes and HTTP status from the proxy receipt

#### Scenario: No round-trip produces a failure result, not a receipt

- **WHEN** the runtime or proxy fails before any request reaches the upstream
- **THEN** the orchestration returns `ok: false` with a stable failure code and does not assemble a receipt

### Requirement: No fallback from cli-resume to reconstructed API submission

`@mosga/replay-submit` SHALL NOT import or invoke `@mosga/direct-submit`, any
reconstructed-request builder, any `submit` function, or any alternate
transport or retry path. The package's dependency graph SHALL NOT reach
`@mosga/direct-submit` through any import. On every failure condition the
orchestration SHALL return a stable failure result and SHALL NOT retry via a
different mode, adapter, converter, or submission path.

#### Scenario: Package surface excludes direct-submit

- **WHEN** the built package's imports and exports are inspected
- **THEN** no import path reaches `@mosga/direct-submit`, a reconstructed-request builder, or a direct `submit` function

#### Scenario: Every failure is terminal

- **WHEN** the orchestration encounters consent, bundle, runtime, proxy, upstream, cancellation, or timeout failures
- **THEN** it returns `ok: false` with a stable code and never invokes a reconstructed-API submission, an alternate converter, or a retry

### Requirement: Unsupported CLI version or capability is a terminal failure

The orchestration SHALL surface the runtime's `cli-version-unsupported` and
`cli-capability-unsupported` failures as terminal results with the source CLI
and replay CLI version (if known). It SHALL NOT broaden the supported
predicates, retry an alternate CLI invocation, or fall back to reconstructed
API submission.

#### Scenario: Unsupported version returns a clear failure

- **WHEN** `runtime.prepare` returns `ok: false` with `cli-version-unsupported`
- **THEN** the orchestration returns `runtime-unsupported` carrying the source CLI and replay CLI version, and performs no execution or submission

#### Scenario: Unsupported capability returns a clear failure

- **WHEN** `runtime.prepare` returns `ok: false` with `cli-capability-unsupported`
- **THEN** the orchestration returns `runtime-unsupported` and does not retry an alternate profile

### Requirement: Stable disclosure-safe orchestration failures

All public orchestration failures SHALL use the closed v1 code set and carry
only stable identifiers: code, stage, source CLI, replay CLI version,
capability profile id, and cleanup state. No public value SHALL include the
real API key, the route token, full request or response bodies, system
prompts, tool schemas, the workspace path, provider error bodies, or any
CLI-generated content.

#### Scenario: Every injected failure maps stably

- **WHEN** tests inject each consent, bundle, prepare, render, register, execute, receipt, and dispose failure category
- **THEN** each result uses its documented stable code/stage and contains no raw cause, key, token, body, or path detail

#### Scenario: Cleanup state is reported

- **WHEN** a failure occurs after preparation or route registration
- **THEN** the failure's `runtimeCleanup` and `proxyCleanup` fields report whether disposal completed, failed, or was not started

### Requirement: Orchestration tests use fake runtime, proxy, and upstream only

Focused tests SHALL use injected fake `ReplayRuntime` and `ReplayProxy`
instances, sealed fake bundles from test fixtures, and fake upstream targets
with no real key. Tests MUST NOT launch a real `claude` or `codex` binary,
contact a real provider endpoint, use a real API key, bind a non-loopback
address, or depend on a specific OS ephemeral-port assignment.

#### Scenario: Test suite is hermetic

- **WHEN** the replay-submit test suite runs on a machine with or without network access and installed CLIs
- **THEN** every runtime interaction, proxy interaction, and upstream target comes from the test fixture or injected fake
