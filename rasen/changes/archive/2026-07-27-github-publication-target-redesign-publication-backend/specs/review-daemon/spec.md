## ADDED Requirements

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
