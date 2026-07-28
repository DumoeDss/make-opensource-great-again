# replay-proxy Specification

## Purpose
TBD - created by archiving change api-direct-submit-cli-replay-proxy. Update Purpose after archive.
## Requirements
### Requirement: Proxy registers one loopback route from a runtime route requirement

`@mosga/replay-proxy` SHALL expose a registrar whose `registerRoute` accepts the
runtime's non-secret `ReplayRouteRequirement` and a separately resolved
`ReplayUpstreamTarget` (real base URL, API format, and key). It SHALL validate
that the upstream target's `targetProviderId` and `targetModel` exactly match the
sealed requirement and SHALL reject a mismatched, loopback, non-HTTPS, or
credential-less upstream before starting a listener. The returned handle's
`binding` SHALL be a `ReplayRouteBinding` whose every source/protocol/auth/target
field equals the requirement, whose `baseUrl` is plain HTTP on `localhost`,
`127.0.0.1`, or `::1` with an explicit port and no userinfo/query/fragment, and
whose `routeToken` and `cliModel` are nonempty.

#### Scenario: Matching upstream produces a valid binding

- **WHEN** the integration supplies an upstream target whose provider/model match a Claude route requirement
- **THEN** the proxy starts a loopback listener and returns a binding the runtime accepts for execution

#### Scenario: Target mismatch is refused before listening

- **WHEN** the upstream target's provider or model differs from the sealed route requirement
- **THEN** registration returns `registration-invalid`, starts no listener, and exposes no upstream URL or key

### Requirement: Each route uses a dedicated loopback listener with an explicit ephemeral port

Each registration SHALL create its own HTTP listener bound to exactly one
loopback address (`127.0.0.1` or `::1`) on an OS-assigned ephemeral port. The
listener SHALL NOT bind to `0.0.0.0`, any non-loopback interface, or a
non-HTTP(S)-loopback scheme. The listener SHALL accept only connections whose
remote address belongs to the bound loopback family.

#### Scenario: Binding URL is loopback with an explicit port

- **WHEN** a route is registered and its binding is inspected
- **THEN** the `baseUrl` host is `127.0.0.1`, `localhost`, or `::1` and the port is a positive integer assigned by the OS

#### Scenario: Non-loopback bind is refused

- **WHEN** an option or upstream target would force the listener onto a non-loopback address
- **THEN** registration returns `registration-invalid` and no listener is created

### Requirement: Route tokens are ephemeral, one-use, and isolated from upstream credentials

The proxy SHALL generate a cryptographically random route token of at least 32
bytes of entropy and place it ONLY in the `ReplayRouteBinding.routeToken` field
and the proxy's in-memory route record. The real upstream API key SHALL remain
inside the non-exported route record and SHALL be sent only as the
converter-selected authorization header on the single outbound upstream request.
The route token, the upstream key, or any derived credential SHALL NOT appear in
the receipt, an error response, a log, a generated config, or any value returned
to the CLI beyond the binding itself.

#### Scenario: Token validation uses constant-time comparison

- **WHEN** the CLI sends a request whose authorization header matches the route token
- **THEN** the proxy accepts the request and proceeds to conversion

#### Scenario: Invalid token is rejected without credential disclosure

- **WHEN** the CLI sends a request whose authorization header is missing, malformed, or mismatched
- **THEN** the proxy returns `route-token-invalid` with an HTTP 401 and a generic body containing no route, target, or key detail

#### Scenario: Upstream key never leaves the proxy process

- **WHEN** a round-trip completes and every observable proxy surface is inspected
- **THEN** the binding, receipt, error results, relayed responses, and logs contain the route token and upstream key nowhere

### Requirement: A route accepts at most one inference request

The proxy SHALL enforce a first-wins one-shot latch per route. The first request
that passes token validation transitions the route to `received` and is processed
through conversion, upstream forwarding, and response relay. Any subsequent
request on the same route SHALL be rejected with `route-already-used` and an HTTP
429. After the response is relayed to the CLI, the route SHALL transition to
`completed` and the listener SHALL close.

#### Scenario: Second request is rejected

- **WHEN** a second HTTP request arrives on a route that has already accepted one
- **THEN** the proxy returns HTTP 429 with `route-already-used`, performs no second upstream forward, and the receipt records `routeClosed: rejected-second-request` only if the first request had not already produced a receipt

#### Scenario: Route closes after a completed round-trip

- **WHEN** the upstream response has been relayed to the CLI
- **THEN** the listener closes, the receipt resolves with `routeClosed: single-shot-completed`, and no further request is accepted

### Requirement: Proxy receipts distinguish CLI-request and outbound-request hashes

The proxy SHALL compute a SHA-256 hash of the exact request body bytes received
from the CLI (before conversion) and a SHA-256 hash of the exact body bytes sent
to the upstream (after conversion), both formatted `sha256:<lowercase-hex>`. The
receipt SHALL record both hashes, the converter id and version, the source and
target protocol identifiers, request count, upstream HTTP status, normalized
usage, and timing. The receipt SHALL NOT include the bundle content hash (which
the integration supplies separately), the real API key, the route token, full
request/response bodies, system prompts, tool schemas, or workspace paths.

#### Scenario: Both hashes are recorded on a completed round-trip

- **WHEN** a Claude CLI sends an Anthropic Messages request that is converted to OpenAI Chat and forwarded successfully
- **THEN** the receipt contains a `cliRequestHash` of the raw Anthropic body and a distinct `outboundRequestHash` of the converted Chat body

#### Scenario: Passthrough produces equal hashes

- **WHEN** a passthrough converter relays a request without body conversion
- **THEN** the `cliRequestHash` and `outboundRequestHash` are equal, proving the body was not altered in transit

### Requirement: Proxy never scans, sanitizes, mutates, or rewrites request content

The proxy SHALL NOT import or invoke any sanitizer, prompt scanner, secret
detector, content rewriter, summarizer, or truncation pass. Converters SHALL
perform structural protocol mapping only. The proxy SHALL NOT modify message
text, system prompts, tool definitions, skill descriptions, terminal metadata,
or any content field; it SHALL only map wire-protocol envelope shape, rewrite the
authorization header from route token to the real upstream key, and adapt
transport framing (e.g., streaming synthesis) as declared by the converter.

#### Scenario: Package surface excludes sanitization

- **WHEN** the built package's imports and exports are inspected
- **THEN** no sanitizer, secret-scanner, content-rewriter, or prompt-mutation surface is reachable

#### Scenario: Message text passes through unchanged

- **WHEN** a CLI request contains a distinct terminal-meta and system-prompt canary
- **THEN** the same canary bytes appear in the outbound body at the converted protocol position and no canary is altered, dropped, or summarized

### Requirement: Proxy never falls back to reconstructed API submission

The proxy SHALL return a stable failure on every error condition (converter
unsupported, upstream error, network failure, route disposed, token invalid, or
internal error) and SHALL NOT invoke any reconstructed-API builder,
direct-submit submission function, alternate transport, alternate converter, or
retry path. The package SHALL NOT import @mosga/direct-submit or any module that
reconstructs provider requests from normalized messages.

#### Scenario: Upstream failure is terminal

- **WHEN** the upstream returns HTTP 500 or the network connection fails
- **THEN** the proxy records `upstream-non-2xx` or `upstream-request-failed`, relays a protocol-valid error to the CLI, and performs no retry or fallback

#### Scenario: Package surface excludes reconstruction

- **WHEN** the built package's dependency graph is inspected
- **THEN** no import path reaches `@mosga/direct-submit`, a reconstructed-request builder, or a direct `submit` function

### Requirement: Response relay returns a CLI-protocol-valid response

The proxy SHALL convert the upstream response back to the CLI's source wire
protocol using the selected converter and return it so the resumed CLI can parse
it and exit. If the CLI requested streaming, the proxy SHALL synthesize a valid
single-event stream from the non-streaming upstream response. A non-2xx upstream
status SHALL be relayed as a protocol-valid error response (not a bare HTTP
status) so the CLI exits cleanly.

#### Scenario: Claude CLI receives a Messages-format response

- **WHEN** a Claude route forwards to an OpenAI Chat target and the upstream returns a Chat Completions response
- **THEN** the CLI receives an HTTP response whose body is a syntactically valid Anthropic Messages response

#### Scenario: Streaming request gets a synthesized single-event stream

- **WHEN** a CLI sends a request with `stream: true` and the upstream returns a non-streaming response
- **THEN** the proxy returns a valid SSE response in the CLI's protocol with a single completion event

### Requirement: Route and proxy lifecycle are explicitly disposable

`ReplayRouteHandle.dispose` SHALL close the listener, abort any in-flight upstream
request, reject or resolve the `receipt` promise with a stable code, and clear
the upstream key from the route record. `ReplayProxy.shutdown` SHALL dispose every
active route and prevent further registration. Both SHALL be idempotent and
SHALL accept an `AbortSignal`.

#### Scenario: Dispose before any request rejects the receipt

- **WHEN** a route is disposed before the CLI has sent any request
- **THEN** the listener closes, the `receipt` rejects with `route-disposed`, and the upstream key is cleared

#### Scenario: Shutdown closes all routes

- **WHEN** the proxy is shut down while multiple routes are registered
- **THEN** every listener closes, every receipt settles with a stable code, and further `registerRoute` returns `proxy-shutdown`

### Requirement: Stable disclosure-safe proxy outcomes

All public proxy failures SHALL use the closed v1 code set and stages. A failure
SHALL contain only code, stage, and route-closed state. No public or logged value
SHALL include the real API key, the route token, full request/response bodies,
provider-specific error bodies, absolute upstream URLs beyond what the caller
supplied, system prompts, tool schemas, or CLI-generated content. HTTP error
responses returned to the CLI SHALL carry a generic JSON body with a stable type
string and no internal detail.

#### Scenario: Every injected failure maps stably

- **WHEN** tests inject each registration, listen, receive, convert, forward, relay, and dispose failure category
- **THEN** each result uses its documented stable code/stage and contains no raw cause, key, token, or body detail

#### Scenario: Upstream error body is not relayed

- **WHEN** the upstream returns a 4xx body that echoes the request and account identifier
- **THEN** the CLI receives a generic protocol-valid error and the receipt records only the HTTP status and stable code

### Requirement: Proxy tests use fake upstreams and loopback mocks only

Focused tests SHALL use an injected fake upstream transport, an injectable
loopback server host, sealed fake route requirements, and converter equivalence
fixtures. Tests MUST NOT contact a real provider endpoint, use a real API key,
launch a source CLI, bind a non-loopback address, or depend on a specific OS
ephemeral-port assignment.

#### Scenario: Test suite is hermetic

- **WHEN** the replay-proxy test suite runs on a machine with or without network access and installed CLIs
- **THEN** every upstream interaction, listener binding, and timing input comes from the test fixture or injected fake

