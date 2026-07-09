## MODIFIED Requirements

### Requirement: Provider targeting with the user's own key, never leaked

The submitter SHALL target a provider from a fixed **allowlist of open-model source-vendor `@omnicross/contracts` presets** plus user-added targets, using the contributor's own API key read server-side from environment, a trusted local config file, or the user-scope provider-key store (never a request body or a client-supplied path). The allowlist SHALL contain exactly the open-source-model source vendors — DeepSeek, z.ai, 智谱 GLM, Kimi (Moonshot), MiniMax, 小米 MiMo (preset ids `deepseek`, `zhipu`, `zhipu-bigmodel`, `kimi`, `minimax`, `xiaomi-mimo`, `xiaomi-mimo-anthropic`) — and SHALL exclude every non-open-source and relay preset. Both the provider list and provider resolution SHALL enforce the allowlist consistently, so a preset outside it is neither listed nor resolvable (UI-hiding alone is insufficient). User-added targets are the contributor's own targets and are always resolvable. The key SHALL be used only as the outbound authorization header and SHALL NEVER appear in the exported/replayed data, the meta message, the consent record, the submission receipt, logs, or any daemon response.

#### Scenario: Key is absent from all serialized outputs

- **WHEN** a submission is prepared and executed
- **THEN** the API key appears in no exported session, meta message, consent record, receipt, or log line — only in the outbound authorization header

#### Scenario: Missing key is a configuration error, not a leak

- **WHEN** no key is configured for the chosen provider
- **THEN** the submit fails with a configuration error and sends nothing, without echoing any partial credential

#### Scenario: Only the allowlisted open-model source vendors are listed

- **WHEN** the provider list is requested
- **THEN** it contains only the allowlisted source-vendor presets plus user-added targets, and excludes every non-open-source and relay preset

#### Scenario: A non-allowlisted preset id is not resolvable

- **WHEN** submission or estimation names a preset id outside the allowlist
- **THEN** provider resolution returns no target and the request is rejected as an unknown provider, so it can never be submitted to

### Requirement: Request reconstruction and format conversion

The submitter SHALL reconstruct an Anthropic-shaped request from the isomorphic `SanitizedSession.messages` (text, thinking, `tool_use` from `toolCalls`, `tool_result` from `toolResults`, roles preserved). For a target whose API format is Anthropic, it SHALL POST the Anthropic request to the target's endpoint; for an OpenAI-format target (e.g. DeepSeek) it SHALL convert via `@omnicross/core`'s Anthropic→OpenAI converter and POST to the target's chat-completions endpoint. For a target whose API format is `gemini`, it SHALL build a Gemini request (reusing `@omnicross/core` message conversion and URL builder) and POST to the Gemini endpoint; for `openai-response`, it SHALL build an OpenAI Responses-API request and POST to that endpoint. The four supported formats are `anthropic`, `openai`, `openai-response`, and `gemini`. Token usage SHALL be parsed for every supported format, including Gemini's `usageMetadata`. Non-text content is marked-not-stored upstream, so replay SHALL be text-and-tool-structure only, and the meta message SHALL disclose this.

#### Scenario: OpenAI-format preset gets a converted request

- **WHEN** the target preset's API format is OpenAI
- **THEN** the reconstructed Anthropic request is converted to OpenAI shape via `@omnicross/core` and POSTed to the preset's chat-completions endpoint

#### Scenario: Anthropic-format preset gets the native request

- **WHEN** the target preset's API format is Anthropic
- **THEN** the reconstructed request is POSTed to the preset's messages endpoint without conversion

#### Scenario: Gemini-format target gets a Gemini request with usage parsed

- **WHEN** the target's API format is `gemini`
- **THEN** a Gemini-shaped request is built and POSTed to the Gemini endpoint, and any returned `usageMetadata` token counts are parsed into the receipt's usage

#### Scenario: OpenAI-Responses-format target gets a Responses request

- **WHEN** the target's API format is `openai-response`
- **THEN** an OpenAI Responses-API request is built and POSTed to the Responses endpoint, and its returned usage is parsed into the receipt's usage
