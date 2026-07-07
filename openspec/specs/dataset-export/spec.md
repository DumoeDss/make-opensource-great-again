# dataset-export

## Purpose

Defines the `@mosga/publisher` exporter: serializing a stamped `SanitizedSession` to the on-disk JSONL dataset format with a version-stamped provenance record, deterministic idempotent placement, and no raw-PII metadata leakage.

## Requirements

### Requirement: Serialize a stamped session to the on-disk dataset format

The `@mosga/publisher` package SHALL serialize a stamped `SanitizedSession` to the on-disk dataset format: JSONL, one record per session, each record a `SanitizedSession` conforming to `@mosga/contracts` `SanitizedSessionSchema` and `SCHEMA.md`. The serialized record's message body SHALL remain structurally isomorphic to the input (dataset slicing beyond one-record-per-session is deferred). Serialization SHALL be lossless (parsing the written line reproduces the published record exactly); export MAY normalize metadata identifiers to strip PII (see "Published metadata carries no raw PII").

#### Scenario: Export round-trips losslessly and keeps the body isomorphic

- **WHEN** a stamped `SanitizedSession` is exported to a JSONL record and parsed back
- **THEN** the parsed record deep-equals the exported record, its message body deep-equals the input's, and it validates against `SanitizedSessionSchema`

#### Scenario: One record per session

- **WHEN** a session is exported
- **THEN** the output is a single JSONL line representing exactly that one session

### Requirement: Reject an un-stamped session

The exporter SHALL only accept a stamped session (`meta.sanitized:true` with `meta.sanitizationRulesetVersion` set). An un-stamped or gate-locked session SHALL be rejected rather than exported.

#### Scenario: Un-sanitized session is refused

- **WHEN** a session with `meta.sanitized:false` (or a null `sanitizationRulesetVersion`) is passed to the exporter
- **THEN** the exporter refuses it and does not produce a record

### Requirement: Provenance/version stamp

Export SHALL emit a provenance stamp recording at least `schemaVersion`, `sanitizationRulesetVersion`, the `@mosga/sanitizer` package version (`sanitizerPackageVersion`), and the gitleaks pin (`gitleaksVersion`), so downstream CI can pin the exact matching engine. The `sanitizationRulesetVersion` in the stamp SHALL match the session's stamped `meta.sanitizationRulesetVersion`.

#### Scenario: Stamp carries the engine version

- **WHEN** a record is exported
- **THEN** the provenance stamp includes the `@mosga/sanitizer` package version, the ruleset version, and the gitleaks pin

#### Scenario: Stamp ruleset version matches the envelope

- **WHEN** the provenance stamp is produced for a stamped session
- **THEN** its `sanitizationRulesetVersion` equals the session's `meta.sanitizationRulesetVersion`

### Requirement: Published metadata carries no raw PII

The exporter SHALL NOT publish raw personally-identifying metadata that the sanitizer's structure-aware scan does not normalize. In particular `session.projectKey` (built by readers as `encodeProjectPath(cwd)` — the raw working-directory path, embedding the contributor's OS username) SHALL be re-derived at export from the already-sanitized `cwd`, so it carries no more PII than `cwd`; when `cwd` is null it SHALL fall back to a fixed non-PII placeholder.

#### Scenario: projectKey is normalized to strip the raw username

- **WHEN** a session whose `cwd` was pseudonymized (e.g. to `<PATH_1>`) but whose `projectKey` still encodes the raw username is exported
- **THEN** the exported record's `projectKey` is derived from the sanitized `cwd` and contains no raw username

### Requirement: Deterministic, idempotent file placement

The exporter SHALL place each record at a deterministic path derived from the session (e.g. `data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl`), so re-exporting the same session targets the same path (idempotent) and parallel contributions never collide on one file.

#### Scenario: Re-export targets the same path

- **WHEN** the same session is exported twice
- **THEN** both exports resolve to the identical deterministic file path
