## Why

The office-hours replay design requires the resumed Claude Code or Codex CLI to
send its assembled request through a local proxy that isolates real upstream
credentials, performs only the protocol conversion the target provider requires,
enforces a single inference round-trip, and emits an auditable receipt. The
shipped runtime now exposes a non-secret `ReplayRouteRequirement` from
preparation and accepts a typed loopback `ReplayRouteBinding` at execution, but
nothing in the repository creates that binding, serves the route, holds the real
provider key, converts between wire protocols, hashes the CLI and outbound
requests, or rejects a second inference attempt.

## What Changes

- Add an isolated, short-lived local HTTP route server that binds only to
  loopback with an explicit ephemeral port, accepts at most one inference
  request per route, and is disposed after the round-trip completes, fails, or is
  cancelled.
- Add a route registrar that consumes the runtime's `ReplayRouteRequirement`,
  accepts a separately resolved upstream target (real base URL, API format, and
  key), and produces a typed `ReplayRouteBinding` matching every prepared
  source/protocol/auth/target field for the runtime to inject.
- Add route-token / upstream-key isolation: the proxy generates an ephemeral
  one-use route token, places only that token in the binding, and retains the
  real upstream credential inside the proxy process where it never enters the
  CLI child environment, a generated config, a log, or a receipt.
- Add a bounded protocol-converter framework with a closed registry, stable
  converter id/version, request and response conversion, and fail-closed
  refusal of unsupported source/target protocol pairs. Ship identity passthrough
  converters and the cross-protocol converters to the common OpenAI Chat
  Completions target format, each independently tested for semantic equivalence.
- Add request-count enforcement and proxy receipts that record the CLI-request
  hash, the outbound-request hash, the converter id/version, HTTP status, usage,
  request count, and timing, without retaining full prompt bytes, the provider
  key, or the route token.
- Add focused tests using a fake upstream transport and an injectable loopback
  server host, covering one-shot enforcement, token validation, credential
  isolation, converter equivalence, hashing, error classification, disposal, and
  the no-fallback/no-sanitizer package boundary.
- Do not render terminal metadata, validate consent, change submit
  orchestration/UI, resanitize content, hold bundle data, or fall back to
  reconstructed API submission.

## Capabilities

### New Capabilities

- `replay-proxy`: Loopback-only one-shot route registration, typed binding
  production, route-token / upstream-key isolation, request-count enforcement,
  upstream transport, dual request hashing, proxy receipts, and stable
  disclosure-safe error contracts.
- `replay-protocol-converters`: Closed, fail-closed converter registry binding
  each supported source wire protocol to each supported target API format, with
  stable id/version, structural (non-mutating) request and response conversion,
  and hermetic semantic-equivalence tests.

### Modified Capabilities

None.

## Impact

- Adds a focused `@mosga/replay-proxy` package depending only on
  `@mosga/contracts` and `@mosga/replay-runtime` (type-only route contracts),
  plus root workspace build/typecheck ordering after `@mosga/replay-runtime`.
- Establishes the public proxy interfaces that the later integration child will
  consume; current `@mosga/direct-submit`, daemon routes, UI, provider-key
  storage, and reconstructed submission behavior remain unchanged.
- Adds a local HTTP listener and outbound `fetch` transport code, but no
  bundle-validation, sanitizer dependency, session rereader, CLI process
  launcher, consent gate, or production orchestration entry point.
