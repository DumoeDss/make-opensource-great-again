## ADDED Requirements

### Requirement: Reconstructed API is explicitly named compatibility mode only

`@mosga/direct-submit`'s `single-shot` and `turn-by-turn` replay modes SHALL
be explicitly labeled as the reconstructed-API compatibility path. They SHALL
NOT be used as an automatic fallback when a `cli-resume` submission fails. A
submit handler that supports both modes SHALL branch on the consent's
`replayMode` field before any side effect and SHALL route `cli-resume`
submissions through the separate `@mosga/replay-submit` orchestration, never
through the reconstructed `submit()` path. The reconstructed path's consent,
meta message, receipt, and behavior SHALL remain unchanged for sessions
submitted under `single-shot` or `turn-by-turn`.

#### Scenario: Reconstructed path is never the default for cli-resume

- **WHEN** a submit handler receives a consent whose `replayMode` is `cli-resume`
- **THEN** the handler routes the submission through `@mosga/replay-submit` and does not call `submit()` from `@mosga/direct-submit`

#### Scenario: Reconstructed path is preserved for compat modes

- **WHEN** a submit handler receives a consent whose `replayMode` is `single-shot` or `turn-by-turn`
- **THEN** the handler calls the existing `submit()` path with unchanged behavior, consent, meta, and receipt shape

#### Scenario: cli-resume failure never falls back to reconstructed API

- **WHEN** a `cli-resume` submission fails at any stage
- **THEN** the handler returns a terminal error and does not retry via `single-shot`, `turn-by-turn`, or any reconstructed-API path
