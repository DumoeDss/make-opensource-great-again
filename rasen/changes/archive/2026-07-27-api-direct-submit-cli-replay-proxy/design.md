## Context

The office-hours design defines request authenticity as a source Claude Code or
Codex CLI resuming a sanitized native session and assembling the request itself.
The shipped runtime now provides the two-phase boundary that precedes and
follows the proxy:

```text
prepare -> render terminal manifest -> register proxy route -> execute -> dispose
```

Preparation exposes a non-secret `ReplayRouteRequirement` (source CLI, source
wire protocol, loopback transport, route-bearer auth, sealed target
provider/model). Execution accepts a typed `ReplayRouteBinding` (baseUrl,
routeToken, cliModel) that must match every prepared field, be plain HTTP on
`localhost`/`127.0.0.1`/`::1` with an explicit port, and carry no userinfo,
query, or fragment. The runtime injects the binding through tested per-profile
environment plans (Anthropic env profile for Claude; `MOSGA_ROUTE_BASE_URL`,
`MOSGA_ROUTE_TOKEN`, `MOSGA_CLI_MODEL` for Codex) and never accepts a real
upstream key.

There is no proxy host today. `@mosga/direct-submit` reconstructs provider
requests from normalized messages and sends them directly via `fetch`; it does
not serve a loopback route, generate route tokens, isolate credentials behind a
token boundary, enforce a single request, or produce CLI/outbound request
hashes. The daemon owns current submission orchestration and provider keys, but
this serial child must not modify it. A focused package is therefore required
between the runtime and the later integration child.

The proxy must also accommodate undocumented, changing CLI and provider wire
details. The office-hours command and protocol sketches are directions, not
permanent shapes. Protocol conversion must be an explicit, tested, versioned
capability, not an optimistic body rewrite or a silent truncation.

## Goals / Non-Goals

**Goals:**

- Provide one public registrar that consumes the runtime's
  `ReplayRouteRequirement` and a separately resolved upstream target, and
  produces a typed `ReplayRouteBinding` for the runtime to inject.
- Serve exactly one loopback HTTP route per registration, bind to an ephemeral
  explicit port on `127.0.0.1` or `::1`, validate the route bearer token, and
  reject a second inference request on the same route.
- Hold the real upstream credential inside the proxy process only; never place
  it in the binding, the CLI child environment, a generated config, a log, a
  receipt, or an error response.
- Convert between the CLI's source wire protocol and the target provider's API
  format using a closed, versioned, fail-closed converter registry that performs
  structural mapping only and never scans, sanitizes, rewrites, truncates, or
  summarizes request or response content.
- Compute SHA-256 hashes of the CLI's raw request body and the converted
  outbound body, and emit a proxy receipt distinguishing both from the bundle
  content hash (which the integration child supplies separately).
- Relay a syntactically valid response back to the CLI in the CLI's source wire
  protocol so the resumed process can parse it, extract the short throwaway
  completion, and exit cleanly.
- Return only stable, disclosure-safe observations, receipts, and error codes.
- Prove the boundary with fake upstream transports, injected loopback server
  hosts, and converter equivalence fixtures; never contact a real provider, use
  a real key, or launch a real CLI.

**Non-Goals:**

- Rendering or interpreting the terminal MOSGA metadata message.
- Validating consent or changing submit daemon/UI orchestration.
- Validating, sealing, serializing, or rereading a `ReplayBundle`.
- Launching, supervising, or cleaning up a source CLI process.
- Rescanning, resanitizing, rewriting, truncating, or summarizing session,
  instruction, prompt, skill, or response content.
- Falling back to the existing reconstructed API path on any failure.
- Providing a general-purpose HTTP server, reverse proxy, TLS terminator,
  firewall, or long-lived multi-tenant route service.
- Resolving provider presets, provider keys, or provider pricing.

## Decisions

### 1. Add a focused `@mosga/replay-proxy` package

The package depends only on `@mosga/contracts` and `@mosga/replay-runtime`. The
runtime dependency is type-only: the proxy imports `ReplayRouteRequirement` and
`ReplayRouteBinding` to produce a structurally and nominally correct binding for
the runtime's `execute`. This preserves the portfolio DAG
(`bundle -> runtime -> proxy -> integration`) and matches the runtime's own
clean-break precedent.

The package deliberately has no dependency on `@mosga/sanitizer` (the proxy
performs no second scan), `@mosga/direct-submit` (structural separation enforces
the no-fallback guarantee), `@mosga/replay-bundle` (the proxy never touches
bundle data), the daemon, or provider-key storage.

Proposed internal layout:

```text
packages/replay-proxy/src/
├─ index.ts                 public surface only
├─ proxy.ts                 registrar, route state machine, receipt assembly
├─ routeServer.ts           loopback listener, request matching, one-shot latch
├─ token.ts                 ephemeral route-token generation
├─ transport.ts             outbound fetch + injectable transport boundary
├─ hashing.ts               SHA-256 of CLI request and outbound body
├─ usage.ts                 normalized usage parsing across provider shapes
├─ errors.ts                stable safe failure/result model
├─ binding.ts               requirement matching + binding construction
└─ converters/
   ├─ types.ts              converter, context, and converted-request contracts
   ├─ registry.ts           closed (source, target) lookup, fail-closed
   ├─ passthrough.ts        identity relay for same-protocol targets
   ├─ anthropicToChat.ts    Anthropic Messages <-> OpenAI Chat Completions
   └─ responsesToChat.ts    OpenAI Responses <-> OpenAI Chat Completions
```

Alternative considered: place the proxy inside `@mosga/direct-submit` or the
daemon. Rejected because this child must be usable by the later integration
child without importing legacy request reconstruction, and because importing
direct-submit would make a reconstructed-submission code path statically
reachable, violating the no-fallback guarantee.

### 2. Export a registrar that produces typed, target-bound bindings

The public surface will be:

```ts
export interface ReplayUpstreamTarget {
  readonly targetProviderId: string;
  readonly targetModel: string;
  readonly upstreamBaseUrl: string;
  readonly upstreamApiKey: string;
  readonly upstreamApiFormat: ReplayApiFormat;
}

export interface ReplayRouteHandle {
  readonly binding: ReplayRouteBinding;
  readonly receipt: Promise<ReplayProxyReceipt>;
  dispose(signal?: AbortSignal): Promise<ReplayRouteDisposeResult>;
}

export interface ReplayProxy {
  registerRoute(
    requirement: ReplayRouteRequirement,
    upstream: ReplayUpstreamTarget,
    options?: ReplayRouteOptions,
  ): ReplayRouteRegistration;
  shutdown(signal?: AbortSignal): Promise<ReplayProxyShutdownResult>;
}

export function createReplayProxy(options?: ReplayProxyOptions): ReplayProxy;
```

`registerRoute` validates that the upstream target's `targetProviderId` and
`targetModel` exactly match the sealed requirement, that the upstream base URL is
a non-loopback HTTPS URL (the proxy must not forward to another loopback address
or to plain HTTP except in explicit local-test configurations), and that the API
key is nonempty. It then starts a dedicated loopback listener, generates an
ephemeral route token, and returns a `ReplayRouteHandle` whose `binding` is the
value the integration passes to `PreparedReplay.execute`.

The `receipt` promise resolves once the single inference round-trip completes
(success or upstream error) and rejects with a stable failure if the route is
disposed without a round-trip, a second request is rejected, or the proxy is
shut down. Because the runtime's `execute` blocks until the CLI exits (which
happens after the CLI receives the proxied response), the round-trip normally
completes before `execute` returns; the integration awaits `receipt`
afterwards.

Alternative considered: a callback-based `onRoundTrip` event. Rejected because a
single `Promise<ReplayProxyReceipt>` is simpler, cannot leak multiple events,
and naturally models the one-shot constraint.

### 3. Bind one dedicated loopback listener per route

Each registration creates its own `http.Server` bound to a single loopback
address (`127.0.0.1` preferred, `::1` accepted) on an ephemeral OS-assigned port
(port `0`). One listener per route gives strong isolation: there is no path or
header routing table where a token from one route could be replayed against
another. The listener accepts only a single inference request; after the
response is relayed (or a second request is rejected), the listener closes.

The server rejects any connection whose remote address is not the bound loopback
family. It does not set `SO_REUSEADDR` beyond the Node default, does not listen
on `0.0.0.0`, and does not terminate TLS (the CLI sees plain HTTP on loopback;
the proxy originates a separate HTTPS connection to the upstream).

Alternative considered: one shared server with path-prefixed routes. Rejected
because it introduces a routing table and increases the blast radius of a token
leak across routes. The dedicated-listener model also keeps the `baseUrl` short
(no path prefix), matching what the runtime's profile env injection expects.

### 4. Generate cryptographically random one-use route tokens

The token is generated using the platform's cryptographic random bytes
(`crypto.randomBytes` / `webcrypto`), encoded to a URL-safe string of at least
32 bytes of entropy. The token is placed only in:

- the `ReplayRouteBinding.routeToken` field (consumed by the runtime and
  injected into the child environment);
- the proxy's in-memory route record (for request validation).

It is never logged, persisted to disk, included in a receipt, returned in an
error response, or forwarded to the upstream. The upstream always receives the
real API key as its authorization header, never the route token.

The proxy validates the token by comparing it against the route record using a
constant-time comparison. A mismatched, missing, or malformed token yields
`route-token-invalid` and an HTTP 401 response with a generic error body
containing no route, target, or key detail.

Alternative considered: a signed JWT carrying route metadata. Rejected because
the proxy is stateful and short-lived; an opaque token validated against an
in-memory record is simpler and cannot leak metadata if intercepted on loopback.

### 5. Enforce at most one inference request per route

The route state machine is:

```text
registered -> listening -> received -> converting -> forwarding
           -> relaying-response -> completed -> closed
         \-> disposed -----------------------------------^
```

- The first request that passes token validation transitions `listening ->
  received` and is processed through conversion, upstream forwarding, and
  response relay.
- After the response is sent to the CLI, the route transitions to `completed`
  and the listener closes. The `receipt` promise resolves.
- Any request arriving after `received` (whether the first is still in flight or
  has completed) is rejected with `route-already-used` and an HTTP 429 response.
  The rejection is recorded only if no receipt has already been produced.
- `dispose` transitions any state to `closed`, aborts any in-flight upstream
  request, closes the listener, and resolves/rejects the `receipt` promise.

This enforces the design's "one inference request per route" rule even if the
CLI attempts a tool-call follow-up or a retry. The proxy does not distinguish
inference from non-inference requests on the same route: in v1 every accepted
HTTP request on the route counts as the single allowed request.

Alternative considered: allow a configurable max-request count. Rejected because
the sealed runtime policy fixes `maxInferenceRequests: 1` and widening it would
violate the consent boundary.

### 6. Protocol conversion is structural, versioned, and fail-closed

The converter framework defines:

```ts
export type ReplayApiFormat =
  | 'anthropic-messages'
  | 'openai-chat-completions'
  | 'openai-responses';

export interface ReplayProtocolConverter {
  readonly id: string;
  readonly version: string;
  readonly sourceProtocol: 'anthropic-messages' | 'openai-responses';
  readonly targetFormat: ReplayApiFormat;
  convertRequest(
    cliRequestBody: Uint8Array,
    context: ReplayConversionContext,
  ): ReplayConvertedRequest;
  convertResponse(
    upstreamResponseBody: Uint8Array,
    context: ReplayConversionContext,
  ): Uint8Array;
}
```

A converter receives the raw CLI request body as bytes and returns the converted
outbound body as bytes plus the target path and required headers. It receives the
raw upstream response body and returns the CLI-compatible response body. It does
not receive the route token, the API key, the bundle, or the workspace path. It
performs purely structural mapping of request/response shape between protocols.

The registry is keyed by `(sourceProtocol, targetFormat)`. If no converter is
registered for the pair implied by the route requirement and the upstream target,
`registerRoute` fails with `converter-unsupported` before the listener starts.
This makes unsupported conversions a registration-time failure, not a
request-time surprise.

Each converter carries a stable `id` and `version` recorded in the receipt, so
the integration child and the user can see exactly which conversion was applied.
The initial set is:

- `anthropic-passthrough-v1`: `anthropic-messages` -> `anthropic-messages`.
  Near-identity: rewrites the authorization header from route-token to the real
  key, sets `anthropic-version`, and passes the body through unchanged.
- `openai-responses-passthrough-v1`: `openai-responses` -> `openai-responses`.
  Near-identity: rewrites the authorization header and passes the body through.
- `anthropic-to-openai-chat-v1`: `anthropic-messages` ->
  `openai-chat-completions`. Maps messages, system prompt, tools, and max-tokens
  to the Chat Completions shape; maps the response back to a Messages-format
  response.
- `openai-responses-to-openai-chat-v1`: `openai-responses` ->
  `openai-chat-completions`. Maps the Responses request to Chat Completions and
  the response back.

Additional pairs (e.g., `anthropic-messages` -> `openai-responses`) fail closed
until a tested converter is added. The implementer may add converters, but each
must ship with semantic-equivalence fixtures and a stable id/version; no
heuristic "best-effort" conversion is permitted.

Alternative considered: import `@mosga/direct-submit`'s reconstruction
converters. Rejected because (a) those converters consume `ParsedMessage[]` and
`SanitizedSession`, not a live CLI request body; (b) importing direct-submit
makes the reconstructed path statically reachable, violating the no-fallback
guarantee; (c) the relay converter has different input/output shapes and
different error semantics.

### 7. Hash both request bodies and emit a disclosure-safe receipt

The proxy computes:

- `cliRequestHash` — SHA-256 of the exact request body bytes the CLI sent (after
  the proxy reads the raw bytes but before any conversion). This proves the
  request was assembled by the CLI runtime, not by MOSGA.
- `outboundRequestHash` — SHA-256 of the exact body bytes sent to the upstream
  provider (after conversion, before transport). This audits the final
  transmitted bytes.

Both hashes use the `sha256:<lowercase-hex>` format established by the bundle.
The receipt does NOT include the bundle content hash: that value comes from the
runtime's `ReplayPreparationObservation` and is merged by the integration child.
Keeping the three hashes in separate components preserves each child's boundary.

```ts
export interface ReplayProxyReceipt {
  readonly sourceCli: SourceCli;
  readonly sourceWireProtocol: 'anthropic-messages' | 'openai-responses';
  readonly targetProviderId: string;
  readonly targetModel: string;
  readonly upstreamApiFormat: ReplayApiFormat;
  readonly converterId: string;
  readonly converterVersion: string;
  readonly cliRequestHash: `sha256:${string}`;
  readonly outboundRequestHash: `sha256:${string}`;
  readonly requestCount: number;
  readonly httpStatus: number;
  readonly usage: SubmissionUsage | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly routeClosed:
    | 'single-shot-completed'
    | 'disposed-unused'
    | 'rejected-second-request';
}
```

The receipt never includes: the real API key, the route token, full request or
response bodies, CLI-generated system prompts, tool schemas, the workspace path,
or any session content. Usage is parsed from the upstream response using the
same normalized `{ inputTokens, outputTokens }` shape across Anthropic, OpenAI
Chat, and OpenAI Responses providers.

Alternative considered: store a truncated request preview in the receipt for
debuggability. Rejected because the CLI request contains the CLI's full system
prompt, tool definitions, and skill descriptions, which the user consented to
send to the provider but not to persist in a local receipt.

### 8. Relay a valid response in the CLI's wire protocol

The proxy forwards the converted request to the upstream using an injectable
transport (default: `fetch`). It receives the upstream response, parses usage,
and converts the response body back to the CLI's source wire protocol via the
same converter's `convertResponse`. The CLI receives an HTTP response that is
syntactically valid in its own protocol so it can parse the throwaway completion,
emit any local output, and exit.

For streaming: if the CLI requested a streaming response, the proxy synthesizes a
single complete-event SSE chunk from the non-streaming upstream response (the
proxy always sends `stream: false` upstream because the response is throwaway).
If the CLI did not request streaming, the proxy returns the converted
non-streaming body. This is part of response conversion, not request mutation:
the semantic content of the response is preserved; only the transport framing
adapts to what the CLI expects.

A non-2xx upstream status is still relayed to the CLI as a protocol-valid error
response (so the CLI can exit cleanly) and is recorded in the receipt with the
real HTTP status and a stable `upstream-non-2xx` code. The proxy does not retry,
does not switch converters, and does not fall back to reconstructed submission.

Alternative considered: always return HTTP 200 to the CLI regardless of upstream
status. Rejected because a CLI that validates response status would hang or
retry; relaying a protocol-valid error lets it exit cleanly.

### 9. Make credential isolation a structural guarantee, not a runtime check

The real upstream API key is accepted ONLY by `registerRoute` as part of
`ReplayUpstreamTarget`. It is stored in a non-exported, frozen route record that
is accessible only to the transport closure. The key:

- is never placed in the `ReplayRouteBinding`, the receipt, an error response, a
  log, or a generated config;
- is sent only as the `Authorization` header (or `x-api-key` for Anthropic
  targets) on the single outbound upstream request;
- is cleared from the route record when the route is disposed.

The proxy package has no public API that accepts or returns arbitrary
environment maps, CLI launch plans, or credential-bearing strings outside
`ReplayUpstreamTarget.upstreamApiKey`. A package-surface test asserts that no
export exposes a credential-forwarding, env-spreading, or key-returning surface.

Alternative considered: pass the key via a callback that returns headers on
demand. Rejected because it adds an indirection that could be misused to inject
arbitrary headers; the single `upstreamApiKey` field plus converter-controlled
header construction is narrower and auditable.

### 10. Return a closed, disclosure-safe error contract

Public operations return discriminated results. `ReplayProxyFailure` contains
only:

```ts
interface ReplayProxyFailure {
  readonly code: ReplayProxyErrorCode;
  readonly stage: ReplayProxyStage;
  readonly routeClosed: ReplayRouteClosedState;
}
```

Stable v1 codes are:

```text
registration-invalid
binding-invalid
converter-unsupported
converter-request-failed
converter-response-failed
route-token-invalid
route-not-found
route-already-used
route-disposed
upstream-request-failed
upstream-non-2xx
proxy-disposed
proxy-shutdown
proxy-internal-error
```

Stages are `register`, `listen`, `receive`, `convert-request`, `forward`,
`convert-response`, `relay`, and `dispose`. No public or logged value includes
the real API key, the route token, full request/response bodies, system prompts,
tool schemas, provider-specific error bodies, or absolute upstream URLs beyond
what the integration already supplied.

HTTP error responses returned to the CLI carry a generic JSON error body with a
stable `type` string and no route, target, key, or body detail. This lets the CLI
exit cleanly without leaking proxy internals into CLI-side logs.

Alternative considered: relay the upstream's error body verbatim to the CLI.
Rejected because provider error bodies can echo the request, include account
identifiers, or leak rate-limit details that the CLI would log.

### 11. Test the child boundary without real providers, keys, or CLIs

Focused tests live in `@mosga/replay-proxy` and use:

- an injected fake upstream transport that asserts the exact outbound URL,
  headers (including the real key), and body, and returns a canned response;
- an injectable loopback server host so tests can drive connection handling,
  second-request rejection, and disposal deterministically;
- sealed fake `ReplayRouteRequirement` values for both Claude and Codex sources;
- converter equivalence fixtures (Anthropic Messages, OpenAI Responses, OpenAI
  Chat shapes) with distinct content-block, tool-schema, system-prompt, and
  model-field canaries;
- route-token and credential canaries proving neither appears in any receipt,
  error, log, or relayed response.

Tests cover: loopback binding correctness, token validation, one-shot rejection,
credential isolation across every observable surface, passthrough byte
equivalence, cross-protocol semantic equivalence, hashing correctness, upstream
2xx/non-2xx/network-error classification, streaming synthesis, converter
fail-closed for unsupported pairs, dispose/shutdown cleanup, and the
package-surface assertion that no sanitizer, direct-submit, bundle, or
reconstructed-API import is reachable.

No test contacts a real provider, uses a real API key, launches a CLI, or binds
a non-loopback address.

## Risks / Trade-offs

- **[A CLI sends multiple HTTP requests as part of one inference (e.g., auth
  probe + inference)]** → v1 treats the first accepted request as the single
  inference; any second request is rejected. If a supported CLI profile is found
  to require a documented preflight, a future profile-scoped exemption (still
  capped at one inference request) may be added; it must not widen the one-shot
  inference guarantee.
- **[Cross-protocol conversion loses semantic fidelity (tools, reasoning,
  system roles)]** → Each converter ships with semantic-equivalence fixtures
  that assert preserved message count, role mapping, tool-schema presence, and
  system-prompt canary survival. A converter that cannot preserve a required
  field fails closed instead of silently dropping it.
- **[A provider error body echoes the request or account details]** → The proxy
  returns a generic CLI-protocol error body and records only the HTTP status and
  a stable code; it never relays the upstream error body to the CLI or persists
  it in the receipt.
- **[The route token is intercepted on loopback by another local process]** →
  The token is high-entropy, one-use, and disposed with the route; even if
  intercepted, it can replay at most one request on a route that is already
  consumed, and it carries no upstream credential.
- **[The proxy process crashes mid-round-trip, leaving the CLI hanging]** → The
  integration child owns the CLI process timeout; the proxy's `receipt` promise
  rejects on dispose/shutdown, and the runtime's execution timeout terminates
  the CLI independently. The proxy does not own CLI lifecycle.
- **[Streaming synthesis produces a malformed SSE chunk]** → The synthesizer is
  covered by fixture tests for both Anthropic and OpenAI streaming event shapes;
  a malformed synthesis is classified as `converter-response-failed`.
- **[One listener per route is perceived as wasteful]** → Routes are
  short-lived (one round-trip) and the cost of an ephemeral loopback socket is
  negligible relative to a CLI resume; the isolation benefit outweighs the
  resource cost.

## Migration Plan

1. Add `@mosga/replay-proxy` with its public types/error contract and root
   build/typecheck ordering after `@mosga/replay-runtime`.
2. Implement the registrar, loopback listener, token generation, route state
   machine, transport, hashing, usage parsing, and receipt assembly.
3. Implement the converter framework, registry, passthrough converters, and the
   two cross-protocol converters to OpenAI Chat Completions.
4. Enable each converter only after its semantic-equivalence fixtures pass.
5. Run package-surface, focused lifecycle/security/equivalence tests, then
   repository-wide typecheck, test, and build gates.
6. Leave the package unused by production daemon/UI submission in this child.
   The integration child owns the prepare/render/register/execute/dispose
   orchestration and merges the proxy receipt with the runtime observation.

Rollback is additive: remove the unused package and root build wiring. No current
session, review, provider, receipt, daemon route, or direct-submit format is
migrated.

## Open Questions

- The exact set of initially supported `(sourceProtocol, targetFormat)` pairs
  beyond the four listed must be fixed from implementation-time compatibility
  fixtures. Until a complete converter is verified, that pair fails closed; this
  is not permission to add a heuristic best-effort conversion.
- If a future CLI profile sends a documented non-inference request before
  inference (e.g., a capabilities probe), the one-shot latch may need a
  profile-scoped allowlist. Until then, every accepted request counts.
- The streaming synthesis shape for OpenAI Responses (event types, item
  structure) must be validated against the Codex CLI's actual parser; if Codex
  rejects synthesized events, the proxy may need to relay a real upstream stream
  for that profile. This is an implementation-time fixture decision, not a
  design-level widening.
