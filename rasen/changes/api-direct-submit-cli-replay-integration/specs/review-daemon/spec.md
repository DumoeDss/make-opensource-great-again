## ADDED Requirements

### Requirement: Submit route branches on replay mode without silent fallback

The daemon's submit endpoint SHALL branch on the consent's `replayMode` before
any side effect. When the mode is `cli-resume`, the handler SHALL route the
submission through `@mosga/replay-submit`'s `submitCliResume` function,
resolving the upstream target and key from the same provider store used by the
reconstructed path. When the mode is `single-shot` or `turn-by-turn`, the
handler SHALL call the existing `submit()` from `@mosga/direct-submit`
unchanged. A `cli-resume` failure SHALL return a terminal HTTP error with a
stable code and SHALL NOT fall through to the reconstructed `submit()` path.

#### Scenario: cli-resume routes through replay-submit

- **WHEN** a submit request carries a consent whose `replayMode` is `cli-resume`
- **THEN** the daemon calls `submitCliResume` with the sealed bundle, consent, upstream target, and injectable runtime/proxy, and returns a `CliResumeReceipt` or a stable error

#### Scenario: Compat mode routes through direct-submit unchanged

- **WHEN** a submit request carries a consent whose `replayMode` is `single-shot` or `turn-by-turn`
- **THEN** the daemon calls the existing `submit()` path with the same behavior, consent validation, backstop, and receipt shape as before

#### Scenario: cli-resume failure does not fall back

- **WHEN** `submitCliResume` returns `ok: false` for any reason
- **THEN** the daemon returns an HTTP error with a stable code (`CONSENT_INVALID`, `BUNDLE_INVALID`, `RUNTIME_UNSUPPORTED`, `RUNTIME_FAILED`, `PROXY_FAILED`, `KEY_NOT_CONFIGURED`, or `SUBMIT_FAILED`) and does not invoke the reconstructed path

### Requirement: Replay preparation produces a sealed bundle from a review's source session

The daemon SHALL expose a replay-preparation endpoint that consumes a review's
held source-session reference, calls the source adapter's
`captureNativeSession`, discovers instruction candidates, builds a
`TerminalManifestSeed` and fixed v1 runtime policy, calls
`createReplayDraft`, runs `scanReplayDraft` with the shared compiled ruleset,
and stores the draft, scan result, and mapper alongside the existing review
state. A separate sealing endpoint SHALL apply reviewed dispositions via
`applyReplayDispositions` and call `sealReplayBundle`, producing a sealed
`ReplayBundle` held in the review state for the submit route to consume. The
replay gate SHALL be unlocked before sealing is permitted.

#### Scenario: Preparation creates a replay draft and scan

- **WHEN** a client requests replay preparation for a review whose source session is accessible
- **THEN** the daemon captures the native session, creates a draft, scans it, stores the replay review state, and returns the replay scan report

#### Scenario: Native capture failure is surfaced

- **WHEN** the source adapter's `captureNativeSession` returns a failure (malformed, partial, or compressed input)
- **THEN** the daemon returns a stable error and creates no draft

#### Scenario: Sealing requires an unlocked replay gate

- **WHEN** a client requests sealing while the replay gate is still locked
- **THEN** the daemon returns a 409 with the gate state and produces no sealed bundle

### Requirement: cli-resume submit error codes are stable and disclosure-safe

The daemon SHALL map `submitCliResume` failures to stable HTTP error codes and
generic bodies. The error response SHALL carry a stable `code` string and
SHALL NOT include the real API key, route token, full request or response
bodies, system prompts, tool schemas, the workspace path, or any
CLI-generated content. The `RUNTIME_UNSUPPORTED` response SHALL include the
source CLI name and replay CLI version (if known) so the user can install or
update the required CLI.

#### Scenario: Unsupported CLI version surfaces actionable detail

- **WHEN** `submitCliResume` returns `runtime-unsupported`
- **THEN** the daemon returns 422 with the source CLI name, replay CLI version, and a `RUNTIME_UNSUPPORTED` code, without retrying an alternate invocation

#### Scenario: Unexpected error returns a generic body

- **WHEN** an unexpected error occurs during cli-resume submission
- **THEN** the daemon logs the detail server-side and returns 500 with a generic `SUBMIT_FAILED` body containing no internal detail
