# review-daemon

## Purpose

Defines the `@mosga/daemon` package: a loopback-only local HTTP server that exposes session enumeration, the stateful review lifecycle (scan, disposition, batch, preview, gated export), and same-origin static serving of the `@mosga/ui` review interface plus its CLI launcher.
## Requirements
### Requirement: Loopback-only HTTP server

The `@mosga/daemon` package SHALL run an HTTP server bound to `127.0.0.1` only, on a configurable port defaulting to 8899. It SHALL NOT bind a non-loopback interface. v0.1 has no authentication; the single-local-user threat model SHALL be documented in the package.

#### Scenario: Binds loopback on the default port

- **WHEN** the daemon starts with no port override
- **THEN** it listens on `127.0.0.1:8899` and does not accept connections on any external interface

#### Scenario: Port is configurable

- **WHEN** a port is supplied via flag or environment variable
- **THEN** the daemon binds that port instead of 8899

### Requirement: Enumeration API over session-readers

The daemon SHALL expose read-only endpoints to list CLI sources (adapters), a source's projects, and a project's sessions, delegating to `@mosga/session-readers` (`listAdapters`/`getAdapter` and the adapter's `listProjects`/`listSessions`). Enumeration SHALL never throw on a missing/unreadable tree — it returns what it can.

#### Scenario: List sources returns the Claude Code adapter

- **WHEN** a client requests the sources list
- **THEN** the response includes the `claude-code` source with its display name

#### Scenario: List sessions returns session refs

- **WHEN** a client requests a project's sessions
- **THEN** the response is the list of session references (id, title, cwd, updatedAt, sizeBytes) for that project

### Requirement: Git-remote whitelist recommendation

The projects endpoint SHALL annotate each project with its git remote (or null) and a `recommended` boolean, marking a project recommended when its `cwd` has a git remote pointing to a recognized public host. This is a recommendation biasing the picker (the design doc's first "专有代码不泄漏" line), NOT an enforcement; the annotation's heuristic nature SHALL be documented.

#### Scenario: Public-remote project is recommended

- **WHEN** a project's `cwd` has a git remote on a recognized public host
- **THEN** the project is annotated `recommended: true` with its remote url

#### Scenario: Project without a public remote is not recommended

- **WHEN** a project's `cwd` has no git remote (or a non-public one)
- **THEN** the project is annotated `recommended: false` and is still listable via an explicit show-all request

### Requirement: Stateful review lifecycle

A create-review endpoint SHALL parse the chosen session via `adapter.parseTranscriptToMessages` (which carries `nonTextContent` markers), wrap it in a `SanitizedSession` envelope (`meta.sanitized:false`), compile the ruleset, run `scanSession`, and store the resulting `{ session, report, mapper }` server-side keyed by a generated review id. Subsequent endpoints SHALL operate on that held state. The held `PseudonymMapper` instance SHALL be retained for use at export.

#### Scenario: Creating a review returns a report and a review id

- **WHEN** a client creates a review for a chosen session
- **THEN** the daemon parses, scans, stores the review state, and returns a review id plus the initial `SanitizationReport` and any `rulesetWarnings`

#### Scenario: The mapper is retained across the review

- **WHEN** dispositions are submitted and then the session is exported
- **THEN** export uses the SAME mapper instance from the review's scan (so `contributorAlias` and placeholders are consistent), not a freshly constructed one

### Requirement: Disposition and batch API

The daemon SHALL expose endpoints to set a single finding's disposition, batch-by-rule, batch-by-type, and set a non-text item's disposition, each delegating to the sanitizer's pure report-transform helpers (`setFindingDisposition`, `batchByRule`, `batchByType`, `setNonTextDisposition`) and returning the recomputed report (with updated `layerSummary` and `gate`). Request bodies SHALL be validated; an invalid disposition value SHALL be rejected.

#### Scenario: Setting a disposition updates the gate

- **WHEN** the last pending blocking finding is dispositioned via the API
- **THEN** the returned report's `gate.blockingPending` decreases and `gate.unlocked` reflects the new state

#### Scenario: Batch-by-type dispositions all findings of a category

- **WHEN** a batch-by-type request for `email` with disposition `replace` is submitted
- **THEN** every `email` finding in the held report becomes `replace` and the recomputed report is returned

#### Scenario: Invalid disposition is rejected

- **WHEN** a request supplies a disposition value outside the allowed set
- **THEN** the daemon returns a validation error and does not mutate the review

### Requirement: Gate status reflects all blocking finding kinds

The gate the daemon reports SHALL be the sanitizer's `computeGate` result, counting every `blocking` finding — including engine findings `ruleset-compile-error` and `redos-guard`. The daemon SHALL also surface the scan's `rulesetWarnings[]` so the client can display them.

#### Scenario: A compile-error finding keeps the gate locked

- **WHEN** a review's scan produced a blocking `ruleset-compile-error` finding still `pending`
- **THEN** the reported `gate.unlocked` is false until that finding is dispositioned

#### Scenario: Ruleset warnings are surfaced

- **WHEN** the scan returned `rulesetWarnings`
- **THEN** the create-review response (and/or a warnings endpoint) includes them

### Requirement: Preview and gated export

The daemon SHALL expose a preview endpoint returning `applyDispositions(...)`'s partially-applied session, and an export endpoint returning the stamped `SanitizedSession` (`meta.sanitized:true`, `sanitizationRulesetVersion` set, `contributorAlias` filled) only when `gate.unlocked` is true; when locked it SHALL return HTTP 409 with the current gate and NOT emit a stamped session. The stamped envelope is the hand-off consumed by slice 4.

#### Scenario: Export is refused while locked

- **WHEN** export is requested while a blocking finding or non-text item is still pending
- **THEN** the daemon returns 409 with the gate and no stamped session

#### Scenario: Export returns the stamped envelope when unlocked

- **WHEN** every blocking finding and non-text item is dispositioned and export is requested
- **THEN** the daemon returns the `SanitizedSession` with `meta.sanitized:true` and the ruleset version stamped

### Requirement: Same-origin static UI serving and CLI launcher

The daemon SHALL serve the built `@mosga/ui` assets at `/ui` from the same origin as the API (no CORS configuration), and SHALL resolve the ui dist at runtime, failing with a clear message if it is missing. A CLI entry SHALL start the daemon and open the browser at `/ui`; if the port is already served by a mosga daemon it MAY adopt it, otherwise it SHALL report the conflict clearly.

#### Scenario: UI is served same-origin

- **WHEN** a browser requests `/ui`
- **THEN** the daemon serves the built UI, and the UI's API calls go to the same origin without CORS

#### Scenario: Missing UI build is reported

- **WHEN** the daemon starts and the ui dist is absent
- **THEN** it reports a clear error rather than serving a blank or 404 page silently

### Requirement: Daemon API integration tests through the real engine

The package SHALL include API integration tests that drive the endpoints against hand-crafted fake session fixtures through the REAL scan/apply engine (no mocked sanitizer). No real session data SHALL be used.

#### Scenario: End-to-end review flow on a fixture

- **WHEN** a test creates a review from a fake fixture with planted fake secrets, dispositions every blocking finding and non-text item, and exports
- **THEN** the API returns a locked gate before completion and a stamped `SanitizedSession` after, using the real sanitizer engine

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

### Requirement: Daemon CLI supports a no-open start for the shell

The daemon CLI SHALL support starting the daemon WITHOUT launching the OS browser (a `--no-open` flag on `mosga ui`), so the desktop shell can spawn the daemon and load the UI in its own webview instead of opening a browser tab. The default `mosga ui` behavior (open the browser) SHALL be unchanged, and the daemon SHALL remain bound to loopback only in both modes.

#### Scenario: No-open start does not open a browser

- **WHEN** the daemon is started with the no-open flag
- **THEN** it binds loopback and serves as usual but does not launch the OS browser

#### Scenario: Default start still opens the browser

- **WHEN** `mosga ui` is run without the no-open flag
- **THEN** it starts the daemon and opens the browser at `/ui` as before

### Requirement: Mutating loopback requests enforce same-origin JSON

Every daemon `POST`, `PUT`, `PATCH`, and `DELETE` route SHALL require an `application/json` media type, reject `Sec-Fetch-Site: cross-site`, and require any supplied `Origin` to equal the current daemon origin derived from the already validated loopback Host. `Origin: null`, alternate scheme/host/port, non-loopback Host, and cross-site browser requests SHALL be refused. Missing Origin MAY be accepted for a non-browser local client, but SHALL NOT bypass Host or content-type checks. The daemon SHALL send no cross-origin allow headers.

#### Scenario: Cross-site publication mutation is refused

- **WHEN** a browser sends a target, preview, or submit mutation with `Sec-Fetch-Site: cross-site` or a non-matching Origin
- **THEN** the daemon returns 403 before invoking the route or changing state

#### Scenario: Non-JSON mutation is refused

- **WHEN** any existing or publication mutation omits JSON content type or uses another media type
- **THEN** the daemon returns 415 before parsing or invoking the handler

#### Scenario: Same-origin mutation proceeds

- **WHEN** a request has a loopback Host, matching Origin, non-cross-site fetch metadata, and JSON content type
- **THEN** the daemon applies normal route validation and handling

### Requirement: Publication dependencies are server-owned and injectable

The daemon SHALL integrate the `GitHubPublication` module through server-owned dependencies for target store, managed root, semantic GitHub port, Git/filesystem/process adapters, journal/receipt stores, clock, IDs, and lock. The production managed root SHALL be derived locally and SHALL have no CLI or HTTP configuration surface. Tests SHALL be able to inject isolated fakes or temporary roots.

#### Scenario: Test app uses isolated publication dependencies

- **WHEN** a daemon integration test injects an in-memory target store, fake GitHub port, and temporary managed root
- **THEN** status/preview/submit use only those dependencies and do not access a real GitHub repository or user publication directory

#### Scenario: Client path input has no injection point

- **WHEN** an HTTP client attempts to configure a publication root or workspace
- **THEN** no daemon request schema accepts the field

### Requirement: Unexpected daemon errors are sanitized

The daemon SHALL NOT serialize an unexpected exception message or raw process output from its top-level dispatcher. Known publication errors SHALL map to stable curated error bodies, and unknown errors SHALL return a generic code/message. A response SHALL never expose a credential, local absolute path, raw matched value, raw stderr/stdout, or command.

#### Scenario: Handler throws sensitive text

- **WHEN** a route dependency throws an exception containing a token, path, command, or stderr
- **THEN** the HTTP response contains only a generic or stable mapped error and none of the sensitive text

### Requirement: Daemon CLI has no local publication-repository surface

The daemon CLI and application options SHALL NOT accept `--data-repo`, `dataRepoPath`, or any replacement path/remote/workspace argument for publication. An obsolete `--data-repo` invocation SHALL fail as an unknown option rather than being ignored or treated as a fallback. Publication target configuration SHALL use only the canonical GitHub target API.

#### Scenario: Obsolete flag is rejected

- **WHEN** the daemon is launched with `--data-repo` in either separated or equals form
- **THEN** startup rejects the unknown option and does not use the supplied path

#### Scenario: Normal startup derives its managed root locally

- **WHEN** the daemon starts without test-only publication dependency injection
- **THEN** it derives the private publication root locally and exposes no path in CLI help or HTTP
