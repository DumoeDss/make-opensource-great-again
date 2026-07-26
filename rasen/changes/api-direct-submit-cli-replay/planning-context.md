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
direct-submit contracts and orchestration code. Under Tier B, child pipelines are
serial even where a dependency could otherwise allow parallelism.

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
