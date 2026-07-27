# Planning Context: API Direct Submit CLI Replay

## User intent

> “$rasen-auto auto-decompose 开始实现吧，创建新的worktree，新建开发分支，完成后提pr”

The implementation must follow the complete design captured in:

- `rasen/office-hours/api-direct-submit-cli-replay-design.md`
- `rasen/office-hours/api-direct-submit-session-context.md`

The primary product goal is **request authenticity**: the outbound request must be
assembled by the source Claude Code or Codex CLI after restoring a sanitized
native session. MOSGA must not reconstruct the CLI system prompt itself.

## Decisions already locked

- Use source-native, structure-preserving sanitized session data for replay.
- Stage sanitized `CLAUDE.md` / `AGENTS.md` instruction context.
- Let the source CLI discover skills; initial runtime normally loads descriptions,
  not complete skill bodies.
- Do not add a second sanitizer or prompt rewrite pass inside the proxy.
- The proxy owns real upstream credentials; the CLI receives only a route token.
- The proxy is one-shot and rejects a second inference request.
- The terminal MOSGA metadata message is the only new conversation turn.
- Never silently fall back from `cli-resume` to reconstructed direct API mode.
- Consent must bind target provider, target model, replay mode, and runtime policy.
- Receipts distinguish bundle, CLI-request, and outbound-request hashes.
- The final delivery is one PR from `feat/api-direct-submit-cli-replay`.

## Worktree

- Path: `E:\AI\ChatAI\Agents\VibeCodingProjects\make-deepseek-great-again-cli-replay`
- Branch: `feat/api-direct-submit-cli-replay`
- Base commit: `a4c0bd2`

The original working tree contains unrelated user changes and must not be modified.

## Decomposition

The portfolio is intentionally serial because the slices converge on shared
direct-submit contracts and orchestration code. The child order is determined by
the dependency DAG, not by a legacy host-tier limitation.

## Codex-native orchestration state

- Current execution view: Codex host, Tier `A`, worker runtime `codex`,
  dispatch mode `native`.
- New leaf workers are dispatched with `spawn_agent`. An idle worker receives a
  new turn through `followup_task`; `send_message` is only for guidance while a
  worker is running.
- A Codex worker's final response is delivered to the LEAD automatically. No
  duplicate completion message is sent.
- `wait_agent` is reserved for one event-driven wait at a real dependency
  barrier; polling loops are not part of this run's protocol.
- Native agent handles are scoped to the host session and expired when the
  session restarted. No old handle is revived and no thread or transcript
  identity is synthesized.
- No Direction workstream/Slice layer exists for this run. The active unit is
  the decomposed portfolio; its Runtime child is at review-loop round 3, after a
  completed fixer pass and before the required independent re-review.
- The Runtime frontier has a real surfaced fixer transcript, so resume
  warm-seeds a fresh native reviewer from that transcript and the durable review
  reports. This is a degraded restart path because the original worker session
  itself cannot be continued.

### 1. `api-direct-submit-cli-replay-bundle`

Foundation contracts and preparation:

- ReplayBundle and integrity contracts.
- Source-native, structure-preserving session staging/sanitization.
- Effective project instruction snapshot representation.
- Deterministic bundle hashing and validation.
- Tests for structural preservation and sensitive-data exclusion.

### 2. `api-direct-submit-cli-replay-runtime`

Depends on bundle:

- Isolated replay workspace lifecycle.
- Source CLI adapter boundary.
- Claude Code resume plan.
- Codex resume plan.
- Read-only skill-root exposure policy.
- Process execution, cancellation, cleanup, and failure classification.

### 3. `api-direct-submit-cli-replay-proxy`

Depends on runtime:

- One-shot local route registration and lifecycle.
- Route-token / upstream-key isolation.
- Claude and Codex proxy environment/config injection.
- Protocol conversion integration without prompt scanning or mutation.
- CLI-request and outbound-request hashing.
- Request-count enforcement and proxy receipts.

### 4. `api-direct-submit-cli-replay-integration`

Depends on runtime and proxy:

- Make `cli-resume` the authenticated direct-submit path.
- Keep reconstructed API as explicitly named compatibility mode only.
- Generate the new deterministic terminal manifest.
- Bind consent to target, mode, instruction policy, and skill policy.
- Extend receipts and daemon/UI/API integration.
- End-to-end tests, compatibility tests, and documentation.

## Dependency DAG

```text
bundle -> runtime -> proxy -> integration
```

## Planning requirements

- Each child proposal must read the complete design and all earlier sibling
  artifacts before choosing interfaces.
- Child implementations must include their own tests; testing is not deferred to
  the integration child.
- Preserve public APIs where practical, but prefer explicit versioned contracts
  over ambiguous legacy `direct` naming.
- Exact CLI flags are version-sensitive. Adapters must detect capabilities and
  fail closed instead of assuming one invocation works forever.
- Do not log full prompts, real credentials, or unsanitized native sessions.
- Do not modify or delete unrelated user changes.

## Durable findings from prior investigation

- Current direct-submit ultimately calls `fetch`; it does not launch source CLIs.
- Current terminal `ContributionMeta` exists but is based on limited normalized
  data.
- Codex parsing currently drops `session_meta` and `turn_context`.
- Claude/Codex session files do not provide a reliable complete runtime system
  prompt.
- Claude Code supports headless resume direction.
- Codex supports `exec resume`.
- Omnicross demonstrates route-token credential isolation and the provider-config
  override needed by Codex.

## Bundle-child interface decisions

- `ReplayBundle` is a separate v1 logical artifact, not an extension of
  `SanitizedSession`. Its integrity root is domain-separated and always formatted
  `sha256:<lowercase-hex>`; the legacy unprefixed sanitized-session hash is not
  interchangeable.
- Native capture preserves the complete semantic JSONL structure (all object rows,
  unknown fields, row order, and references) and canonicalizes only JSON key
  order/whitespace/line endings. Native replay capture fails closed on malformed,
  partial, non-object, or compressed Codex input; it never inherits the normalized
  readers' skip-and-continue behavior.
- The runtime child must accept only `validateReplayBundle` output, use the
  foundation's canonical JSONL bytes, and choose the version-specific CLI storage
  layout. It must not reread or mutate the original session/project, resanitize the
  payload, or accept a legacy content hash.
- Instruction closure discovery is outside the foundation contract. The caller
  supplies explicit candidates; the bundle stores only sanitized content and a
  validated aliased POSIX `stagePath`/effective order, never an original absolute
  path. Runtime materialization must stage exactly that snapshot and no broader
  project tree.
- The bundle seals a fixed terminal-manifest seed. The integration child later
  renders the sole terminal user message by combining that seed with the validated
  bundle hash, separately validated consent, and the runtime-observed replay CLI
  version; it may not enrich the manifest by rereading raw session metadata.
- Replay scan/apply uses one review report and pseudonym scope across native rows,
  instruction content, and fixed source/terminal metadata. Proxy and runtime
  children receive no sanitizer mutation API.

## Bundle implementation findings (tasks 1.1 through 4.3)

- Strict capture assigns zero-based ordinals across nonblank JSONL rows. Blank
  lines and source whitespace are not semantic inputs; later runtime
  materialization must use the foundation serializer and must preserve the
  stored file order, row order, ordinals, JSON values, and reference fields.
- Codex `response_item` is the trajectory-count source of truth.
  `event_msg` mirrors remain in the native artifact but must not be counted as
  extra user/assistant/tool events by runtime or integration receipts.
- Replay scan reports bind both a canonical draft-content hash and a
  SHA-256 hash of each matched span. Apply fails closed on either stale
  coordinate/value; later children must not bypass the reviewed payload by
  accepting a draft or report independently.
- Opaque blocks are never stripped automatically. Only reviewed `keep`,
  `remove`, or explicit JSON `replace` decisions can unlock them; remove/replace
  appends a sanitized omission that contains no opaque source bytes.

## Final bundle-foundation handoff (tasks 4.4 through 6.4)

The exported implementation boundary is:

```text
session-readers
  CliSourceAdapter.captureNativeSession(ref) -> NativeCaptureResult

sanitizer
  scanReplayDraft(draft, ruleset, options?) -> ReplayScanResult
  applyReplayDispositions(draft, report, mapper, {
    ruleset,
    expectedRulesetVersion,
    decisionVersion,
    approvedAt?
  }) -> ReplayDispositionApplyResult

replay-bundle
  createReplayDraft(input) -> ReplayBundleDraft
  canonicalizeReplayJson(value) -> Uint8Array
  serializeNativeJsonl(file) -> Uint8Array
  serializeInstructionFile(file) -> Uint8Array
  sealReplayBundle(reviewedPayload) -> ReplayBundle
  validateReplayBundle(untrustedInput) -> ReplayBundlePayload
```

- Replay apply independently binds the draft id, canonical draft-content hash,
  caller-held expected ruleset version, compiled ruleset, terminal-seed
  provenance, report, and replay-scoped pseudonym mapper. Runtime/integration
  must pass the mapper returned by the matching scan and must never combine a
  draft, report, or mapper from separate review runs.
- A locked replay gate may produce an immutable preview, but
  `sealablePayload` is `null`. Only an unlocked gate whose output is
  schema-valid and whose post-apply same-ruleset scan finds no surviving
  replace/delete blocking canary receives `humanReviewPassed: true` evidence.
  Review evidence redacts match previews and never copies opaque source or
  replacement bytes.
- The six `@mosga/replay-bundle` runtime exports are pure. Construction accepts
  only explicit native capture, instruction candidates, terminal seed, runtime
  policy, delivery, and omissions; it performs no project discovery. Integrity
  operations throw fail-closed errors with stable
  `ReplayBundleIntegrityErrorCode` values.
- Runtime must call `validateReplayBundle` before materialization and then use
  `serializeNativeJsonl` and `serializeInstructionFile` for the exact staged
  bytes. Validation is self-contained, rederives every sorted entry and the
  domain-separated root, and rejects unsafe/duplicate paths, mutations,
  missing/extra entries, unsupported versions, malformed digests, and legacy
  unprefixed hashes.
- Instruction candidate bytes are fatal-decoded as UTF-8, normalized to LF,
  deterministically sorted by `(effectiveOrder, stagePath)`, and stored without
  the original source path. Stage paths are relative POSIX paths whose basename
  must match the declared `CLAUDE.md`/`AGENTS.md` kind. Runtime must stage only
  these entries and must not rediscover instructions.
- Native entry digests are sensitive to row order; the root is additionally
  sensitive to the complete reviewed payload, including target and fixed
  policy. The proxy may observe hashes but has no bundle mutation or
  sanitization API, and integration must bind consent/receipts to the validated
  `sha256:` bundle root.

## Runtime-child interface decisions

- `@mosga/replay-runtime` is a validation-owning two-phase boundary. Its public
  `prepare({ bundle, skillRoots, signal })` accepts an untrusted bundle, calls
  `validateReplayBundle` before bundle-derived writes, and returns an opaque
  one-use `PreparedReplay`. The safe preparation observation exposes the
  validated bundle hash, recorded/runtime CLI versions, selected profile, sealed
  target, and non-secret route requirements, but no workspace, command,
  environment, prompt, token, path, or native body.
- Later orchestration order is `prepare -> render terminal manifest -> register
  proxy route -> execute -> dispose`. The proxy supplies a typed loopback-only
  `ReplayRouteBinding` matching the prepared source protocol and sealed target;
  runtime receives only the ephemeral route token, never a real upstream key.
  Terminal input is passed exactly once over stdin, and the token is injected
  only through the child environment.
- Claude Code and Codex layouts/invocations are internal tested capability
  profiles selected by both observed version and required probe evidence.
  Unknown, newer, incomplete, or ambiguous combinations fail before resume;
  adapters never try alternate commands or reconstructed submission.
- Runtime stages native and instruction bytes only through the bundle canonical
  serializers, stages exactly the sealed instruction snapshot, never discovers
  project instructions or rereads/resanitizes source data, and protects live
  skill roots with bounded detached read-only snapshots. All process outcomes
  clean the private workspace and expose only stable safe codes; raw CLI output,
  prompts, route tokens, credentials, paths, and session/skill bodies are never
  logged or returned.

## Runtime implementation handoff

- Initial support is closed to capability-complete
  `claude-code-2.1-headless-resume-v1` (Claude Code 2.1.x) and
  `codex-0.101-exec-resume-responses-v1` (Codex 0.101.x). Integration must
  surface the runtime's unsupported-version/capability result and must not
  broaden these predicates or retry another invocation.
- `ReplayRouteBinding.baseUrl` must be plain HTTP on `localhost`, `127.0.0.1`,
  or `::1` with an explicit port and no userinfo, query, or fragment. The binding
  must exactly repeat every prepared source/protocol/auth/target field. Proxy
  registration therefore precedes `execute`, but proxy internals and upstream
  credentials remain unrepresentable in the runtime input.
- An `execute` call consumes its prepared handle before route, terminal-input,
  timeout, or process validation. Any integration retry requires a fresh
  `prepare` and a new proxy route/token; `dispose` remains mandatory and
  idempotent in orchestration cleanup.
- Codex provider control stores only the environment-variable names
  `MOSGA_ROUTE_BASE_URL`, `MOSGA_ROUTE_TOKEN`, and `MOSGA_CLI_MODEL`; Claude
  routing is likewise injected by runtime through its tested Anthropic
  environment profile. Later children supply only the typed binding and must
  not write CLI config or pass arbitrary environment maps.

## Proxy-child interface decisions

- `@mosga/replay-proxy` is a focused package depending only on
  `@mosga/contracts` and `@mosga/replay-runtime` (type-only import of
  `ReplayRouteRequirement` / `ReplayRouteBinding`). It deliberately does NOT
  depend on `@mosga/direct-submit`, `@mosga/sanitizer`, or
  `@mosga/replay-bundle`. The structural separation from direct-submit enforces
  the no-fallback guarantee at the import graph level: no reconstructed-API
  code path is statically reachable from the proxy.
- The route types (`ReplayRouteRequirement` / `ReplayRouteBinding`) are defined
  in `@mosga/replay-runtime/src/types.ts`, NOT in `@mosga/contracts`. Moving
  them to contracts would require modifying the immutable runtime package, so
  the proxy consumes them via type-only import. This creates the correct
  build-order dependency (runtime before proxy) matching the portfolio DAG.
- The proxy receipt carries only `cliRequestHash` and `outboundRequestHash`,
  NOT the `bundleContentHash`. The bundle hash originates in the runtime's
  `ReplayPreparationObservation`; the integration child merges the three
  hashes into the final receipt. Keeping each hash in its originating child
  preserves boundary isolation.
- The proxy's `registerRoute` is the single point that accepts the real upstream
  API key (`ReplayUpstreamTarget.upstreamApiKey`). The key is stored only in a
  non-exported route record, sent only as the converter-selected authorization
  header on the single outbound request, and cleared on dispose. No public
  proxy API accepts arbitrary environment maps or credential-bearing strings
  outside this one field.

## Proxy-child findings (propose stage)

- The rasen strict validator's SHALL/MUST check inspects only the FIRST PHYSICAL
  LINE of each requirement body text. A requirement whose first line is an
  introductory clause without SHALL/MUST fails `--strict` validation even when
  SHALL appears later in the same paragraph. All spec requirement bodies must
  lead with a sentence containing SHALL or MUST on the first wrapped line.
- Each proxy route uses a dedicated loopback listener (one `http.Server` per
  registration on an ephemeral OS-assigned port). This avoids a shared
  path-routing table where one route's token could be replayed against another,
  and keeps the `baseUrl` short (no path prefix), matching what the runtime's
  profile env injection expects.
- The v1 converter set is four converters (two passthrough + two cross-protocol
  to OpenAI Chat Completions). Any other `(sourceProtocol, targetFormat)` pair
  fails closed at registration with `converter-unsupported`. The integration
  child must surface this as a terminal failure and must not retry with a
  different target or converter.

## Integration-child findings (propose stage)

- The `TerminalManifestSeed` sealed in the bundle does NOT carry
  `humanReviewPassed` (that lives in `ReplayReviewEvidence`) or the omissions
  disclosure list (that lives in the bundle payload's `omissions` array). The
  terminal-manifest renderer must receive these as explicit additional inputs
  extracted from the validated bundle payload, not from the seed alone. This
  is the tightest point of the "no enrichment" rule: the renderer reads from
  the validated bundle but never rereads the original session.
- `ReplayPreparationObservation` exposes only source CLI, bundle hash,
  recorded/replay CLI versions, capability profile, delivery target, and route
  requirement — NOT the seed, omissions, or review evidence. The orchestration
  must therefore independently call `validateReplayBundle` to extract the
  seed/omissions/review BEFORE calling `runtime.prepare`. The runtime
  re-validates internally for its own materialization; both validations derive
  the same domain-separated root hash. The consent is validated against the
  extracted payload before the expensive `prepare` call (CLI probe +
  workspace).
- The no-fallback guarantee operates at THREE levels, not two: (1) structural
  — `@mosga/replay-submit` has no import path to `@mosga/direct-submit`; (2)
  runtime — `submitCliResume` returns `{ ok: false }` on every failure; (3)
  daemon-handler — the submit route branches on `consent.replayMode` before
  any side effect and a cli-resume error never falls through to the existing
  `submit()` call. Level 3 is necessary because the daemon imports both
  packages and is the sole fan-in point.
- The existing `ContributionConsent` binds the `SanitizedSession` content hash
  and the `single-shot` / `turn-by-turn` modes — both irrelevant to
  cli-resume. A separate `CliResumeConsent` schema (binding the bundle
  `sha256:` root, `cli-resume` mode, instruction/skill policy, and a new
  `runtimeContextAcknowledged` flag) keeps each path's consent
  self-consistent and avoids overloading the legacy schema.
- Replay preparation (native capture → draft → scan → review → seal) is a
  parallel review flow to the existing normalized one, not a modification of
  it. The existing review produces a `SanitizedSession`; the replay review
  produces a sealed `ReplayBundle`. Both use the same compiled ruleset, but
  the replay path scans native JSONL rows + instruction content via the
  sanitizer's `scanReplayDraft` / `applyReplayDispositions` APIs. The daemon
  stores both review states keyed by the same review id.
