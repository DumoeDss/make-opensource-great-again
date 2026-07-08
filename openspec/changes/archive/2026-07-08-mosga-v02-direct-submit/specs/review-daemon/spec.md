## ADDED Requirements

### Requirement: Provider list endpoint

The daemon SHALL expose `GET /api/providers` returning the open-model provider presets (from `@omnicross/contracts`) plus any user-added targets, with id, display name, models, and API format only. It SHALL NEVER return API keys.

#### Scenario: Providers are listed without keys

- **WHEN** a client requests `GET /api/providers`
- **THEN** the response lists selectable providers and their models, and contains no key material

### Requirement: Submission cost-estimate endpoint

The daemon SHALL expose `POST /api/reviews/:reviewId/submit/estimate` taking a target provider, model, and replay mode, returning a token-cost estimate for that review WITHOUT sending anything. It SHALL 404 for an unknown review.

#### Scenario: Estimate returns without sending

- **WHEN** a client posts an estimate request for a known review with a provider, model, and mode
- **THEN** a token estimate is returned and no provider request is made

### Requirement: Gated submission endpoint

The daemon SHALL expose `POST /api/reviews/:reviewId/submit` that derives the stamped session from the held review state (as the export route does) and drives 出口② submission. It SHALL return 409 when the gate is locked, 422 when consent is missing or invalid or its content hash mismatches, a block error when the pre-send backstop finds a surviving blocking finding, and otherwise a key-free `SubmissionReceipt`. It SHALL 404 for an unknown review.

#### Scenario: Locked gate returns 409

- **WHEN** submit is called for a review whose gate is not unlocked
- **THEN** the daemon responds 409 with the gate and sends nothing

#### Scenario: Invalid consent returns 422

- **WHEN** submit is called without valid, content-bound consent
- **THEN** the daemon responds 422 and sends nothing

#### Scenario: Successful submit returns a key-free receipt

- **WHEN** submit is called on an unlocked review with valid consent and the backstop passes
- **THEN** the daemon replays to the provider and returns a `SubmissionReceipt` that contains no API key
