## 1. Package and public contracts

- [x] 1.1 Scaffold `@mosga/replay-proxy` as an ESM/tsup workspace package depending only on `@mosga/contracts` and `@mosga/replay-runtime` (type-only route contracts), and place it after replay-runtime in root build/typecheck order.
- [x] 1.2 Define the closed `ReplayProxyErrorCode`, stage, route-closed-state, failure, registration result, receipt, dispose result, and shutdown result types.
- [x] 1.3 Define `ReplayApiFormat`, `ReplayUpstreamTarget`, `ReplayRouteOptions`, `ReplayRouteHandle`, `ReplayProxyOptions`, `ReplayProxy`, and the `createReplayProxy` factory public interfaces.
- [x] 1.4 Define the internal `ReplayProtocolConverter`, `ReplayConversionContext`, and `ReplayConvertedRequest` contracts in `converters/types.ts` (non-exported from the package surface).
- [x] 1.5 Add a package-surface test proving only the high-level proxy/types are exported and no sanitizer, direct-submit, bundle-validator, session rereader, reconstructed-API, arbitrary HTTP-server, or credential-forwarding surface is exposed.

## 2. Registrar, upstream validation, and binding construction

- [x] 2.1 Implement `createReplayProxy` returning a frozen `ReplayProxy` with `registerRoute` and `shutdown`, parameterized by an injectable loopback server host, an injectable upstream transport, and a crypto-random source.
- [x] 2.2 Implement `registerRoute` validation: require exact equality of `targetProviderId` and `targetModel` between the route requirement and the upstream target; require a nonempty upstream API key; require the upstream base URL to be absolute HTTPS (or an explicit local-test HTTP exception) and reject loopback, userinfo, query, or fragment.
- [x] 2.3 Implement binding construction that produces a `ReplayRouteBinding` repeating every prepared source/protocol/auth/target field, with a loopback `baseUrl` (`127.0.0.1`/`localhost`/`::1`, explicit port, no userinfo/query/fragment), a nonempty `routeToken`, and a nonempty `cliModel`.
- [x] 2.4 Add tests for matching upstream registration, every provider/model/baseUrl/key mismatch, binding field equality with the requirement, and `proxy-shutdown` refusal after shutdown.

## 3. Loopback route server and one-shot latch

- [x] 3.1 Implement a dedicated `http.Server` per route bound to one loopback address on an ephemeral port, rejecting non-loopback remote addresses, with injectable server creation for tests.
- [x] 3.2 Implement the route state machine (`registered -> listening -> received -> converting -> forwarding -> relaying-response -> completed -> closed`, plus `disposed`) behind a first-wins latch that permits exactly one accepted request.
- [x] 3.3 Implement request reception that reads the raw CLI request body fully into memory (bounded by a configured max-request-bytes limit), validates the route bearer token via constant-time comparison, and classifies token mismatch as `route-token-invalid` (HTTP 401).
- [x] 3.4 Implement second-request rejection: any request arriving after the latch is consumed returns `route-already-used` (HTTP 429) with a generic body and performs no second upstream forward.
- [x] 3.5 Add tests for loopback binding, non-loopback connection refusal, first-request acceptance, second-request rejection, oversized-request refusal, and token validation (valid, missing, malformed, mismatched).

## 4. Route-token generation and credential isolation

- [x] 4.1 Implement cryptographically random route-token generation (>=32 bytes entropy, URL-safe encoding) using an injectable random source.
- [x] 4.2 Store the upstream key and route token only in a non-exported, frozen route record accessible only to the transport and token-validation closures; clear the key on dispose.
- [x] 4.3 Add canary tests proving the route token and upstream key never appear in the binding (beyond `routeToken`), receipt, error results, relayed CLI responses, or logs across every code path.

## 5. Protocol converter framework and passthrough converters

- [x] 5.1 Implement the converter registry keyed by `(sourceProtocol, targetFormat)` with fail-closed lookup that returns `converter-unsupported` for unregistered pairs before listener startup.
- [x] 5.2 Implement `anthropic-passthrough-v1` (`anthropic-messages` -> `anthropic-messages`): rewrite the authorization header from the route token to the real key, set `anthropic-version`, pass the body through unchanged, and pass the response through unchanged.
- [x] 5.3 Implement `openai-responses-passthrough-v1` (`openai-responses` -> `openai-responses`): rewrite the authorization header and pass request/response bodies through unchanged.
- [x] 5.4 Add equivalence tests asserting byte-identical outbound vs CLI bodies, equal `cliRequestHash`/`outboundRequestHash`, correct authorization header, and no body mutation for both passthrough converters.

## 6. Cross-protocol converters to OpenAI Chat Completions

- [x] 6.1 Implement `anthropic-to-openai-chat-v1` request conversion mapping Anthropic Messages (system, messages with content blocks, tools, tool_use/tool_result, max_tokens, model) to OpenAI Chat Completions (`/v1/chat/completions`) with no content loss.
- [x] 6.2 Implement `anthropic-to-openai-chat-v1` response conversion mapping a Chat Completions response back to a syntactically valid Anthropic Messages response (content blocks, stop_reason, usage, model).
- [x] 6.3 Implement `openai-responses-to-openai-chat-v1` request conversion mapping OpenAI Responses (instructions, input items, function tools, model) to Chat Completions with no content loss.
- [x] 6.4 Implement `openai-responses-to-openai-chat-v1` response conversion mapping a Chat Completions response back to a syntactically valid OpenAI Responses response (output items, status, usage).
- [x] 6.5 Add hermetic semantic-equivalence fixtures for each cross-protocol converter covering single-turn, multi-turn, tool-bearing, system-prompt-bearing, and streaming-requested shapes, asserting content-block/tool-schema/system-prompt/model canary survival in both directions.

## 7. Upstream transport, hashing, and receipt assembly

- [x] 7.1 Implement an injectable transport boundary (`(req) => Promise<{status, body}>`) with a default `fetch`-based implementation that sends the converted request with the real key header and returns status + raw response bytes.
- [x] 7.2 Implement SHA-256 hashing of the raw CLI request bytes (before conversion) and the converted outbound bytes (after conversion), both formatted `sha256:<lowercase-hex>`.
- [x] 7.3 Implement normalized usage parsing from the upstream response across Anthropic (`input_tokens`/`output_tokens`), OpenAI Chat (`prompt_tokens`/`completion_tokens`), and OpenAI Responses (`input_tokens`/`output_tokens`) shapes.
- [x] 7.4 Assemble the `ReplayProxyReceipt` with both hashes, converter id/version, source/target identifiers, request count, HTTP status, usage, ISO timestamps, duration, and `routeClosed` reason; resolve the handle's `receipt` promise on completion.
- [x] 7.5 Add tests for hash correctness against known vectors, usage parsing across provider shapes, receipt field completeness, and the absence of key/token/body/URL/prompt detail in the receipt.

## 8. Response relay and streaming synthesis

- [x] 8.1 Implement response relay that calls the converter's `convertResponse` and returns the converted body to the CLI with an HTTP status and content-type valid for the CLI's wire protocol.
- [x] 8.2 Implement streaming synthesis: when the CLI request indicated streaming, synthesize a valid single-event SSE stream in the source protocol's event format (Anthropic `message_start`/`message_delta`/`message_stop` or OpenAI Responses `response.created`/`response.completed`) from the non-streaming upstream response.
- [x] 8.3 Implement non-2xx relay: convert a non-2xx upstream response into a protocol-valid error response for the CLI (so the CLI exits cleanly) while recording the real HTTP status and `upstream-non-2xx` in the receipt.
- [x] 8.4 Add tests for non-streaming relay correctness, streaming-event validity (parseable as SSE with the expected event sequence), non-2xx relay producing a clean CLI exit, and the absence of upstream error-body detail in the relayed response.

## 9. Error handling, lifecycle, and disclosure safety

- [x] 9.1 Implement the closed `ReplayProxyErrorCode`/stage mapping for every failure category (registration, listen, receive, convert-request, forward, convert-response, relay, dispose) with stable codes and no raw cause in public output.
- [x] 9.2 Implement generic CLI-facing HTTP error bodies (stable `type` string, no route/target/key/body detail) for token, one-shot, converter, and upstream errors.
- [x] 9.3 Implement `ReplayRouteHandle.dispose` (idempotent, AbortSignal-aware): close listener, abort in-flight upstream request, settle the `receipt` promise with `route-disposed` if no round-trip completed, and clear the upstream key.
- [x] 9.4 Implement `ReplayProxy.shutdown` (idempotent, AbortSignal-aware): dispose every active route, prevent further registration, and close any shared resources.
- [x] 9.5 Add tests for every error code/stage, generic-body disclosure, dispose-before-request, dispose-mid-round-trip, double-dispose idempotency, shutdown-closes-all-routes, and post-shutdown registration refusal.

## 10. Boundary verification and compatibility

- [x] 10.1 Add end-to-end fake-upstream round-trip tests for both Claude (anthropic-messages) and Codex (openai-responses) source protocols covering: valid binding, single accepted request, correct conversion, correct hashes, receipt resolution, and listener closure.
- [x] 10.2 Add exhaustive disclosure canary tests: route-token, upstream-key, system-prompt, tool-schema, terminal-meta, and skill-description canaries are absent from every receipt, error result, relayed CLI error response, and log across success and failure paths.
- [x] 10.3 Add source-scan tests proving the package cannot import `@mosga/direct-submit`, `@mosga/sanitizer`, `@mosga/replay-bundle` validators/serializers, session rereaders, reconstructed-API builders, or any consent/daemon/UI module.
- [x] 10.4 Document the package's public register/execute-adjacent/await-receipt/dispose handoff for the integration child, including the explicit no-fallback, no-sanitizer, and no-bundle-touching guarantees.
- [x] 10.5 Run the replay-proxy focused tests and confirm they never contact a real provider, use a real API key, launch a CLI, or bind a non-loopback address.
- [x] 10.6 Run replay-runtime, replay-bundle, contracts, direct-submit, daemon, and existing focused suites to confirm the additive package changes no current behavior.
- [x] 10.7 Run repository-wide typecheck, test, and build commands and resolve package export/build-order/platform regressions.
