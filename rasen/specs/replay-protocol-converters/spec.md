# replay-protocol-converters Specification

## Purpose
TBD - created by archiving change api-direct-submit-cli-replay-proxy. Update Purpose after archive.
## Requirements
### Requirement: Converter registry is closed and fail-closed per source/target pair

`@mosga/replay-proxy` SHALL contain an internal converter registry keyed by the
pair `(sourceProtocol, targetFormat)`. Route registration SHALL look up the
converter for the pair implied by the route requirement's `wireProtocol` and the
upstream target's `upstreamApiFormat` and SHALL fail with
`converter-unsupported` before starting a listener when no converter is
registered. The registry SHALL NOT fall back to a nearest-match, identity, or
best-effort converter for an unregistered pair.

#### Scenario: Supported pair selects one converter

- **WHEN** a route requirement names `anthropic-messages` and the upstream target names `openai-chat-completions`
- **THEN** registration selects the `anthropic-to-openai-chat-v1` converter and records its id and version

#### Scenario: Unsupported pair fails at registration

- **WHEN** a route requirement names `openai-responses` and the upstream target names `anthropic-messages` for which no converter is registered
- **THEN** registration returns `converter-unsupported`, starts no listener, and performs no request

### Requirement: Each converter carries a stable id and version recorded in the receipt

Every converter SHALL expose a stable `id` and `version` string. The proxy SHALL
record both in the receipt so the integration child and the user can see exactly
which conversion was applied. A converter's id/version SHALL NOT change without a
new tested converter and a receipt-affecting version bump.

#### Scenario: Receipt identifies the applied converter

- **WHEN** a round-trip completes through the `openai-responses-to-openai-chat-v1` converter
- **THEN** the receipt's `converterId` and `converterVersion` identify that converter uniquely

### Requirement: Converters perform structural protocol mapping only

Converters SHALL accept the raw CLI request body as bytes and return the
converted outbound body as bytes plus the target path and required headers. They
SHALL perform purely structural mapping of request/response envelope shape
between protocols (message roles, content-block layout, tool-schema placement,
system/developer role handling, model field, and max-tokens). They SHALL NOT
scan for secrets, rewrite message text, drop tool definitions, summarize or
truncate history, inject or delete a system prompt, append MOSGA metadata, or
mutate any content the CLI assembled at runtime.

#### Scenario: Content canaries survive conversion

- **WHEN** a CLI request carries distinct system-prompt, terminal-meta, tool-schema, and user-message canaries
- **THEN** each canary appears unchanged in the converted outbound body at the target protocol's position

#### Scenario: No content is dropped silently

- **WHEN** a converter cannot map a required field to the target protocol
- **THEN** conversion fails with `converter-request-failed` rather than omitting the field

### Requirement: Passthrough converters preserve byte-equivalence

A passthrough converter (same `sourceProtocol` and `targetFormat`) SHALL forward
the request body unchanged except for the authorization header (rewritten from
the route token to the real upstream key) and any protocol-required version
header. The `cliRequestHash` and `outboundRequestHash` for a passthrough
round-trip SHALL be equal.

#### Scenario: Anthropic passthrough is byte-identical

- **WHEN** a Claude route targets an Anthropic-native upstream and the round-trip completes
- **THEN** the outbound body equals the CLI body byte-for-byte and both recorded hashes are equal

#### Scenario: Responses passthrough is byte-identical

- **WHEN** a Codex route targets an OpenAI-Responses-native upstream and the round-trip completes
- **THEN** the outbound body equals the CLI body byte-for-byte and both recorded hashes are equal

### Requirement: Cross-protocol converters preserve semantic equivalence

Each cross-protocol converter SHALL preserve the semantic content of the request
across the format conversion: message count and role mapping (system, user,
assistant, tool), content-block text preservation, tool-call and tool-result
structure, and the model field. A converter SHALL be enabled only after
hermetic equivalence fixtures assert every mapped field for representative
single-turn and multi-turn shapes. Unsupported structures SHALL fail closed
instead of being silently dropped.

#### Scenario: Anthropic-to-Chat preserves messages and tools

- **WHEN** an Anthropic Messages request with system prompt, two user turns, one assistant turn, and a tool definition is converted to OpenAI Chat Completions
- **THEN** the converted body preserves every message role and text block, maps the Anthropic system to the Chat Completions system role, and retains the tool schema in the Chat Completions tools field

#### Scenario: Responses-to-Chat preserves items and tool calls

- **WHEN** an OpenAI Responses request with instruction, message items, and a function tool call is converted to OpenAI Chat Completions
- **THEN** the converted body preserves every item's role and content and maps the tool call to the Chat Completions tool_calls structure

### Requirement: Converters convert upstream responses back to the CLI wire protocol

Each converter SHALL provide response conversion that maps the upstream
provider's response body back to a syntactically valid response in the CLI's
source wire protocol. For a passthrough converter, the response body SHALL pass
through unchanged. For a cross-protocol converter, the response SHALL map content
blocks, usage, model, and stop reason to the source protocol's response shape. If
the CLI requested streaming, the proxy SHALL synthesize a valid single-event
stream from the non-streaming upstream response in the source protocol's event
format.

#### Scenario: Chat response is converted back to Anthropic Messages

- **WHEN** an OpenAI Chat Completions upstream response is received for a Claude route
- **THEN** the CLI receives a body that is a syntactically valid Anthropic Messages response with the completion text and usage mapped

#### Scenario: Chat response is converted back to OpenAI Responses

- **WHEN** an OpenAI Chat Completions upstream response is received for a Codex route
- **THEN** the CLI receives a body that is a syntactically valid OpenAI Responses response with the output item and usage mapped

### Requirement: Converter tests are hermetic and fixture-driven

Each enabled converter SHALL have captured fixtures for representative request
and response shapes (single-turn, multi-turn, with tools, with system prompt, and
with streaming requested). Tests SHALL assert semantic equivalence using
content-block, tool-schema, system-prompt, and model-field canaries. The
converter matrix test SHALL cover every enabled pair and every unsupported pair
that must fail closed. No converter test SHALL contact a network endpoint or use
a real provider key.

#### Scenario: Matrix rejects every unsupported pair

- **WHEN** each `(sourceProtocol, targetFormat)` pair without a registered converter is presented at registration
- **THEN** the corresponding registration fails with `converter-unsupported` and no listener starts

#### Scenario: Equivalence fixtures cover representative shapes

- **WHEN** each enabled converter's equivalence suite runs
- **THEN** single-turn, multi-turn, tool-bearing, system-prompt-bearing, and streaming-requested fixtures all pass without content loss

