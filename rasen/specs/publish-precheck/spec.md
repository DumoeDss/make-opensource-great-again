# publish-precheck

## Purpose

Defines the `@mosga/publisher` mandatory local pre-check: an independent, defense-in-depth re-scan of the exact bytes about to be published — including a raw-bytes backstop pass covering fields the structure-aware scanner does not visit — that hard-refuses publication on any surviving blocking finding.

## Requirements

### Requirement: Mandatory pre-check re-scans the artifact bytes

The publisher compiler SHALL pre-check every exact record file body before returning a `ContributionBundle`. After a sealed preview and explicit confirmation, the publication backend SHALL re-obtain current stamped sessions, recompile with the same trusted ruleset/options, validate the complete bundle, and before any journal/workspace/Git/GitHub mutation SHALL repeat the structured plus raw-byte pre-check on each sealed exact record body, including its trailing newline. It SHALL also run the raw-byte backstop over every exact provenance sidecar. The final gate SHALL cover the exact strings later written, not human decisions or reconstructed content.

#### Scenario: Submit rechecks exact sealed records

- **WHEN** a confirmed submit reaches its final pre-write gate
- **THEN** every sealed record body is re-scanned byte-for-byte with the shared compiled ruleset before any local or remote mutation

#### Scenario: Provenance bytes receive a raw backstop

- **WHEN** a bundle contains provenance sidecar contents
- **THEN** the final pre-write gate scans those exact bytes with the raw-byte backstop and refuses a surviving blocking value

#### Scenario: Reconstructed bytes cannot substitute

- **WHEN** current publisher recompilation differs from the sealed contract/digest/file commitments
- **THEN** submit is stale and does not precheck or write a separately reconstructed artifact as a replacement

### Requirement: Hard-refuse on any surviving blocking finding

If compiler preview or final submit pre-check yields any blocking finding—`secrets`, `custom`, `redos-guard`, or `ruleset-compile-error`—publication SHALL be refused with deterministic per-review/session counts grouped by rule only. It SHALL produce no partial seal on preview refusal and no journal, file, commit, fork, push, or pull request on final refusal. Match previews, raw values, exact file contents, local paths, and subprocess text SHALL NOT cross the compiler/publication HTTP boundary.

#### Scenario: Multiple final refusals are aggregated safely

- **WHEN** exact sealed bytes for multiple records contain surviving blocking findings
- **THEN** submit returns every refused review/session with counts by rule and no sensitive finding detail

#### Scenario: Final refusal has zero mutation

- **WHEN** the final submit pre-check refuses any record or sidecar
- **THEN** recording filesystem, Git, GitHub, journal, and receipt adapters observe zero write calls

#### Scenario: Clean final bytes proceed

- **WHEN** every exact sealed record and sidecar passes its required final scans and all other submit bindings remain valid
- **THEN** the backend may begin the managed publication journal/workspace flow

### Requirement: Non-blocking findings do not block publication

The pre-check SHALL NOT refuse on Layer-3 `normalization` (non-blocking) findings; only blocking findings gate publication. This mirrors the gate semantics (L3 is statistics + sampling, not a hard block).

#### Scenario: Residual normalization hit does not block

- **WHEN** the pre-check finds only non-blocking normalization findings (e.g. a placeholder or an allowed path)
- **THEN** publication proceeds

### Requirement: Pre-check parity with CI is version-pinned

The compiler and publication backend SHALL surface and seal `sanitizerPackageVersion`, `rulesetVersion`, and `gitleaksVersion`. Submit SHALL use the same trusted compiled ruleset/options and SHALL reject missing, changed, or unsupported engine identity before mutation. The community CI SHALL be able to match the sealed provenance pins exactly; divergence SHALL be visible and fail closed.

#### Scenario: Engine pins remain equal through submit

- **WHEN** preview and submit use the same trusted engine
- **THEN** the sealed bundle, final pre-check, provenance sidecars, and receipt flow retain matching engine identity

#### Scenario: Engine identity is stale

- **WHEN** current trusted compiler/pre-check identity differs from the sealed engine pins
- **THEN** submit returns a stale/incompatible error and performs no mutation
