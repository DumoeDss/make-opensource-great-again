## ADDED Requirements

### Requirement: Versioned ReplayBundle contract

`@mosga/contracts` SHALL export schemas and inferred TypeScript types for `ReplayBundleDraft`, `ReplayBundlePayload`, and `ReplayBundle`. A sealed bundle SHALL contain a `payload` and `integrity`; the payload SHALL contain schema version `1.0.0`, source context, source-native session data, an instruction snapshot, a terminal-manifest seed, runtime policy, delivery target, explicit omissions, and approved review evidence. The schema SHALL reject unknown bundle schema versions and SHALL NOT contain an upstream API key, route token, original absolute path, complete skill body, CLI-generated system prompt, or tool schema.

#### Scenario: Complete v1 bundle validates

- **WHEN** a bundle contains every required v1 payload and integrity field with supported enum values
- **THEN** `ReplayBundleSchema` accepts it and preserves all typed fields

#### Scenario: Forbidden runtime secret is not representable

- **WHEN** a caller attempts to place an API key or route token in a bundle field not defined by the schema
- **THEN** strict bundle validation rejects the extra field instead of preserving it

### Requirement: Source-native session representation

The bundle payload SHALL represent each native session file as a logical role/path and an ordered array of JSONL rows. Each row SHALL retain its ordinal and complete JSON-object value, including unknown row types, unknown object fields, nested arrays/objects, scalar types, duplicate logical events, and session/turn/parent/tool-call reference values. The representation SHALL define JSON semantic structure and row order as its preservation boundary; original whitespace, key order, and line endings SHALL NOT be required.

#### Scenario: Unknown rows and fields survive preparation

- **WHEN** a fake Claude or Codex transcript includes an unknown row type and unknown nested fields between known rows
- **THEN** the prepared native artifact retains the same row count/order and the unknown values unchanged

#### Scenario: Reference structure survives sanitization

- **WHEN** a transcript contains parent/session/tool-call identifiers and sanitization replaces an unrelated sensitive string
- **THEN** the identifiers and their structural locations remain unchanged in the reviewed payload

### Requirement: Safe project-instruction snapshot

The payload SHALL represent each reviewed instruction as kind `claude-md` or `agents-md`, a stable id, a nonnegative outer-to-inner `effectiveOrder`, sanitized UTF-8/LF content, and a POSIX `stagePath` relative to the future replay root. `stagePath` MUST reject absolute, drive-qualified, UNC, backslash-containing, NUL-containing, empty-segment, `.`/`..` traversal, and non-`CLAUDE.md`/`AGENTS.md` basename paths. Duplicate stage paths SHALL be rejected. The stored snapshot SHALL NOT retain the candidate's original absolute source path.

#### Scenario: Valid aliased instruction chain is accepted

- **WHEN** candidates map to `workspace/CLAUDE.md` and `workspace/project-1/AGENTS.md` with distinct effective orders
- **THEN** the snapshot retains the sanitized content in deterministic `(effectiveOrder, stagePath)` order

#### Scenario: Traversal path is rejected

- **WHEN** an instruction candidate uses `../CLAUDE.md`, an absolute path, or a Windows drive path as its stage path
- **THEN** draft construction fails before any bundle can be sealed

### Requirement: Explicit instruction and context omissions

The payload SHALL contain structured omissions for every effective instruction or source-context element known to have been excluded, with a stable reason code and sanitized human-readable disclosure. An empty omission list SHALL mean only that the caller reported no known omissions; it SHALL NOT cause the foundation to claim that discovery was complete.

#### Scenario: Excluded instruction is disclosed

- **WHEN** the caller excludes an effective `AGENTS.md` candidate because it was not approved
- **THEN** the payload records an instruction omission whose reason is covered by the bundle integrity hash

### Requirement: Reviewed source context and terminal-manifest seed

The payload SHALL store a reviewed source summary and deterministic terminal-manifest seed derived before sealing. The summary SHALL distinguish source models/model timeline from `delivery.targetModel`, SHALL keep recorded CLI version separate from the later replay CLI version, and SHALL carry available trajectory counts and omission policy. The seed SHALL bind purpose/schema, source summary, trajectory, sanitization provenance, runtime mode `cli-resume`, instruction policy `sanitized-snapshot`, skill policy `cli-discovery-read-only`, `proxyRescan: false`, `maxInferenceRequests: 1`, target provider, and target model. It SHALL exclude route data, provider credentials, replay CLI version, actual request hashes, receipt fields, and the post-review consent instance.

#### Scenario: Source and target models remain distinct

- **WHEN** a reviewed source trajectory names multiple source models and delivery targets a different model
- **THEN** the seed preserves the source model timeline separately from the delivery target

#### Scenario: Dynamic fields are absent before sealing

- **WHEN** a ReplayBundle payload is constructed
- **THEN** it has no replay CLI version, route token, CLI-request hash, outbound-request hash, or receipt timestamp field

### Requirement: Runtime and delivery policy are sealed inputs

The payload SHALL require target provider id, target model, replay mode, instruction policy, skill policy, project/working-directory aliases, and maximum inference request count as fixed reviewed inputs. For schema v1, replay mode MUST be `cli-resume`, instruction policy MUST be `sanitized-snapshot`, skill policy MUST be `cli-discovery-read-only`, proxy rescan MUST be false, and maximum inference request count MUST be exactly one.

#### Scenario: Policy mutation changes the sealed content

- **WHEN** an otherwise identical reviewed payload changes its target model or skill policy
- **THEN** sealing produces a different bundle content hash

#### Scenario: Unsafe request-count policy is rejected

- **WHEN** a v1 payload requests more than one inference request
- **THEN** schema validation rejects it before sealing

### Requirement: Review evidence gates sealing

A sealable payload SHALL include replay review evidence with ruleset, report, and decision versions; redacted findings and their dispositions; approval timestamp; and `humanReviewPassed: true`. `sealReplayBundle` SHALL refuse a draft with a pending blocking finding, unresolved opaque/non-text review item, failed review, stale/unresolvable finding location, or mismatched ruleset/report identity. Persisted findings SHALL NOT contain the full raw matched secret.

#### Scenario: Locked replay draft cannot be sealed

- **WHEN** one blocking finding remains `pending`
- **THEN** `sealReplayBundle` returns a stable gate error and no ReplayBundle

#### Scenario: Approved replay draft can be sealed

- **WHEN** every blocking and opaque item is dispositioned and review evidence matches the sanitized payload
- **THEN** sealing produces a ReplayBundle with `humanReviewPassed: true`

### Requirement: Deterministic domain-separated integrity seal

`@mosga/replay-bundle` SHALL implement canonicalization id `mosga-replay-canonical-json-v1`: JSON object keys sorted deterministically, array order preserved, no insignificant whitespace, UTF-8 encoding, and rejection of undefined, non-finite, or non-JSON values. Sealing SHALL derive sorted per-entry records containing logical path, media type, byte length, and `sha256:<lowercase-hex>` digest, then hash the canonical preimage `{ domain: "mosga-replay-bundle:v1", payload, entries }`. The root `contentHash` field itself SHALL be excluded from that preimage.

#### Scenario: Identical payloads seal identically

- **WHEN** the same reviewed payload is sealed twice in separate calls
- **THEN** both bundles have byte-identical entry manifests and the same prefixed content hash

#### Scenario: Row order affects integrity

- **WHEN** two payloads differ only by the order of two native session rows
- **THEN** their native entry digest and root content hash differ

### Requirement: Fail-closed ReplayBundle validation

`validateReplayBundle` SHALL strict-schema-validate a bundle, reserialize native/instruction entries, rederive the complete sorted entry manifest, and recompute the domain-separated root hash. It SHALL return a validated payload only when the stored and recomputed manifest and root match exactly. Unsupported version, unsafe logical path, missing/extra entry, changed content, changed policy, or malformed digest SHALL produce a stable validation error without consulting the original session or project.

#### Scenario: Content mutation is detected

- **WHEN** one character in a sealed instruction file or native string leaf is changed without resealing
- **THEN** validation rejects the bundle for an integrity mismatch

#### Scenario: Validation is self-contained

- **WHEN** the original session and project are unavailable but the bundle is intact
- **THEN** validation succeeds using only the supplied ReplayBundle

### Requirement: Narrow preparation and runtime handoff

The foundation SHALL expose pure draft construction, canonical native JSONL serialization, seal, and validate APIs. Draft construction SHALL accept an already captured native artifact and explicitly supplied instruction candidates; it SHALL NOT discover a whole project tree. This capability SHALL NOT launch Claude Code/Codex, materialize a CLI home, expose skill roots, register a proxy route, perform provider conversion, send a request, or silently produce a reconstructed API fallback.

#### Scenario: Foundation preparation has no execution side effect

- **WHEN** a ReplayBundle is prepared and sealed from fake inputs
- **THEN** no child process, network request, provider-key read, original-project write, or skill-body read occurs

### Requirement: Focused fake-fixture guarantees

ReplayBundle tests SHALL use only hand-crafted fake Claude/Codex JSONL and fake instruction files in repository fixtures or temporary directories. Tests MUST cover unknown-field preservation, `session_meta`/`turn_context` preservation, consistent cross-artifact pseudonyms, canary exclusion, malformed/unsupported input refusal, instruction path safety, deterministic hashing, and mutation detection. No test SHALL read a developer's real CLI session, instruction file, credential, or project.

#### Scenario: Sensitive canary is excluded everywhere

- **WHEN** the same obviously fake sensitive canary appears in a native row, a nested encoded argument string, and an instruction file and each finding is dispositioned `replace`
- **THEN** the sealed payload and every canonical content entry contain only the approved replacement and no original canary
