# direct-submit Specification

## Purpose
TBD - created by archiving change mosga-v02-direct-submit. Update Purpose after archive.
## Requirements
### Requirement: Submission consumes only a gate-unlocked stamped session

The 出口② submitter SHALL operate only on a gate-unlocked, stamped `SanitizedSession` (`meta.sanitized: true`, produced after every blocking finding and non-text item is dispositioned). It SHALL refuse to send when the session is un-stamped or the review gate is locked. It SHALL NOT re-run or weaken the human gate; it consumes the same stamped artifact 出口① consumes.

#### Scenario: Locked gate refuses submission

- **WHEN** submission is requested for a review whose gate is not unlocked
- **THEN** no request is sent to any provider and the caller is told the gate is locked

#### Scenario: Stamped session is accepted

- **WHEN** submission is requested for a review whose gate is unlocked
- **THEN** the submitter derives the stamped session (the same artifact the export path returns) and proceeds to the consent + backstop checks

### Requirement: Pre-send raw-bytes backstop over the exact outbound bytes

The submitter SHALL scan the EXACT serialized outbound request bytes (converted messages plus the meta message) with the shared compiled `@mosga/sanitizer` ruleset before any bytes leave the machine, replicating the publisher's raw-bytes-backstop pattern. Any Layer-1/2 blocking finding (`secrets`, `custom`, `redos-guard`, `ruleset-compile-error`) SHALL hard-refuse the send with no allow-escape. This check SHALL be independent of the human gate, so a secret a human mistakenly allowed — or one reintroduced by format conversion or the meta message — is still caught. Layer-3 normalization findings SHALL NOT block. The submitter SHALL NOT modify or import the publisher's pre-check module.

#### Scenario: A secret in the outbound bytes blocks the send

- **WHEN** the exact serialized request about to be POSTed contains a blocking secret pattern anywhere (including inside the meta message)
- **THEN** the backstop refuses the send, no request reaches the provider, and the surviving blocking finding is reported

#### Scenario: Backstop is independent of the human gate

- **WHEN** a real secret was mistakenly `allow`ed in the human review yet survives into the outbound bytes
- **THEN** the pre-send backstop still refuses the send (there is no allow-escape at this layer)

### Requirement: Informed-consent gate bound to content

The submitter SHALL require a `ContributionConsent` record before sending: it SHALL contain explicit `tosRiskAcknowledged` and `fullRetentionAcknowledged` acknowledgments (both must be true), the target provider/model, the replay mode, the estimate shown to the user, a `contentHash`, and a confirmation timestamp. The submitter SHALL recompute the content hash from the stamped session and refuse the send when consent is absent, either acknowledgment is false, or the hash does not match the content being sent (consent given for different content). The accepted consent SHALL be recorded in the submission provenance. No API key material SHALL be part of the consent record.

#### Scenario: Missing or unacknowledged consent refuses the send

- **WHEN** submission is requested without consent, or with either acknowledgment false
- **THEN** no request is sent and the caller is told consent is required

#### Scenario: Consent bound to different content is rejected

- **WHEN** the consent's `contentHash` does not match the stamped session being submitted
- **THEN** the send is refused (consent cannot be replayed against changed content)

#### Scenario: Accepted consent is recorded in provenance

- **WHEN** a send succeeds
- **THEN** the submission receipt records the consent acknowledgments, target, replay mode, and content hash

### Requirement: Provider targeting with the user's own key, never leaked

The submitter SHALL target a provider from the `@omnicross/contracts` open-model presets plus user-added targets, using the contributor's own API key read server-side from environment or a trusted local config file (never a request body or a client-supplied path). The key SHALL be used only as the outbound authorization header and SHALL NEVER appear in the exported/replayed data, the meta message, the consent record, the submission receipt, logs, or any daemon response.

#### Scenario: Key is absent from all serialized outputs

- **WHEN** a submission is prepared and executed
- **THEN** the API key appears in no exported session, meta message, consent record, receipt, or log line — only in the outbound authorization header

#### Scenario: Missing key is a configuration error, not a leak

- **WHEN** no key is configured for the chosen provider
- **THEN** the submit fails with a configuration error and sends nothing, without echoing any partial credential

### Requirement: Request reconstruction and format conversion

The submitter SHALL reconstruct an Anthropic-shaped request from the isomorphic `SanitizedSession.messages` (text, thinking, `tool_use` from `toolCalls`, `tool_result` from `toolResults`, roles preserved). For a preset whose API format is Anthropic, it SHALL POST the Anthropic request to the preset's endpoint; for an OpenAI-format preset (e.g. DeepSeek) it SHALL convert via `@omnicross/core`'s Anthropic→OpenAI converter and POST to the preset's chat-completions endpoint. Non-text content is marked-not-stored upstream, so replay SHALL be text-and-tool-structure only, and the meta message SHALL disclose this.

#### Scenario: OpenAI-format preset gets a converted request

- **WHEN** the target preset's API format is OpenAI
- **THEN** the reconstructed Anthropic request is converted to OpenAI shape via `@omnicross/core` and POSTed to the preset's chat-completions endpoint

#### Scenario: Anthropic-format preset gets the native request

- **WHEN** the target preset's API format is Anthropic
- **THEN** the reconstructed request is POSTed to the preset's messages endpoint without conversion

### Requirement: Replay modes and token-cost estimation

The submitter SHALL provide a token-cost estimate for a session against a chosen provider/model/mode WITHOUT sending, so the estimate can be shown at consent time. It SHALL support a linear single-shot ingestion mode (default) that sends the whole conversation plus the meta message in one request, and an opt-in turn-by-turn mode whose cost grows quadratically with turn count. The estimate SHALL reflect the selected mode.

#### Scenario: Estimate is produced without sending

- **WHEN** an estimate is requested for a review, provider, model, and mode
- **THEN** a token estimate is returned and no request is sent to any provider

#### Scenario: Single-shot is the default replay mode

- **WHEN** a submission is made without specifying a replay mode
- **THEN** the single-shot ingestion mode is used (one request carrying the full conversation plus the meta message)

### Requirement: Contribution meta message attached to the replay

The submitter SHALL attach a `ContributionMeta` payload as the terminal turn of the replay, carrying provenance (tool, ruleset, and sanitizer-package versions, contributor alias, license, source CLI, session id), a consent acknowledgment block, and a human-readable disclosure that this is a sanitized community-contributed trajectory with non-text media absent. Because the meta message is part of the outbound bytes, it SHALL be covered by the pre-send backstop.

#### Scenario: Meta message is the terminal turn and well-formed

- **WHEN** a single-shot replay request is built
- **THEN** the conversation ends on the meta message as a user turn, so the request is well-formed (one assistant completion follows)

#### Scenario: Meta message carries provenance, not keys

- **WHEN** the meta message is serialized
- **THEN** it contains the tool/ruleset/sanitizer versions, contributor alias, license, and consent acknowledgment, and contains no API key

