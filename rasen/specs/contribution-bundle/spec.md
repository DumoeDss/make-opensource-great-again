# contribution-bundle Specification

## Purpose

Defines the `@mosga/publisher` pure contribution-bundle compiler: a target-independent operation that accepts stamped sessions, runs the mandatory pre-check on exact final record bytes, and returns deterministic files, byte/hash metadata, PR metadata, and a content digest sufficient for the publication backend to seal and deliver.

## Requirements

### Requirement: Unified contribution-bundle compilation

The publisher SHALL expose one synchronous `compileContributionBundle` operation that accepts 1–500 stamped `SanitizedSession` values and returns one `ContributionBundle`, with N=1 using the same validation, export, pre-check, ordering, hashing, and rendering pipeline as N>1. The compiler SHALL reject an empty or oversized input, differing exact contributor aliases, duplicate raw session IDs, and duplicate derived repo-relative file paths.

#### Scenario: One session uses the unified compiler

- **WHEN** the compiler receives one valid stamped session
- **THEN** it returns the same bundle contract used for multiple sessions without delegating to a separate single-session planner

#### Scenario: Slug collision is refused

- **WHEN** distinct session IDs derive the same deterministic record or provenance path after slugification
- **THEN** compilation fails before returning a bundle rather than allowing one file to overwrite another

#### Scenario: Invalid collection is refused

- **WHEN** the compiler receives zero sessions, more than 500 sessions, duplicate session IDs, or differing contributor aliases
- **THEN** it rejects the collection without returning a partial bundle

### Requirement: Bundle carries exact contribution files

Each `ContributionBundle` SHALL have `contractVersion: 1` and SHALL contain every record and provenance sidecar as a `ContributionBundleFile` with `kind`, raw `sessionId`, repo-relative POSIX `path`, exact `contents`, UTF-8 `bytes`, and lowercase hexadecimal SHA-256 `contentHash`. The bundle SHALL also contain canonical per-record summaries, `recordCount`, `totalBytes`, and the common pre-check `engine`. `totalBytes` SHALL equal the sum of all file byte counts.

#### Scenario: Exact record and sidecar bytes are complete

- **WHEN** two stamped sessions compile successfully
- **THEN** the bundle contains exactly two JSONL record files and two provenance sidecars whose `contents` are the literal UTF-8 strings the downstream workspace must write

#### Scenario: Byte counts use UTF-8

- **WHEN** file contents contain multibyte Unicode characters
- **THEN** each `bytes` value and `totalBytes` use UTF-8 byte length rather than JavaScript character count

### Requirement: Mandatory pre-check covers final record file bytes

The compiler SHALL run the mandatory publication pre-check on every exported record's exact `fileContents`, including the trailing newline that will be written, using the shared compiled ruleset and raw-byte backstop. It SHALL check all records without fail-fast. If any record is refused, it SHALL throw a typed bundle refusal containing deterministic per-session rule-aggregated counts only and SHALL return no bundle.

#### Scenario: Multiple refusals are aggregated safely

- **WHEN** two records in one requested bundle retain blocking findings
- **THEN** one refusal names both session IDs with counts grouped by rule and exposes no match preview, raw matched value, record content, path, or subprocess text

#### Scenario: Clean exact bytes proceed

- **WHEN** every final JSONL file body has zero surviving blocking findings
- **THEN** compilation returns the complete bundle with the shared pre-check engine identity

#### Scenario: Refusal has no publication side effect

- **WHEN** any record fails the mandatory pre-check
- **THEN** no partial bundle, filesystem write, process execution, network request, workspace mutation, or GitHub mutation occurs

### Requirement: Canonical exact-content digest

For each file, `contentHash` SHALL be SHA-256 over the exact UTF-8 encoding of `contents`. `contentDigest` SHALL be SHA-256 over the UTF-8 JSON serialization of files sorted by `path` and projected in exact property order to `{ path, bytes, contentHash }`. All digests SHALL be lowercase hexadecimal. This v1 algorithm SHALL be covered by fixed test vectors.

#### Scenario: Same file set has the same digest

- **WHEN** the same logical sessions and compiler options are supplied in any input order
- **THEN** the canonical file list, per-file hashes, and full content digest are byte-for-byte identical

#### Scenario: Any content or path change changes identity

- **WHEN** any exact file byte or repo-relative file path changes
- **THEN** its file commitment and the aggregate content digest change

### Requirement: Deterministic content-bound metadata

The compiler SHALL sort sessions by raw session ID using locale-independent ordinal comparison and SHALL sort files by repo-relative path. It SHALL derive branch, commit message, PR title, and PR body only from canonical input data and explicit compiler options, without reading a wall clock or machine state. The branch SHALL be `contrib/<alias>/<sessionId>-<digest8>` for N=1 and `contrib/<alias>/batch-<digest8>` for N>1, where `digest8` is the first eight characters of `contentDigest`.

#### Scenario: Input order cannot change output

- **WHEN** the same session set is compiled in different input orders
- **THEN** the entire returned bundle, including record rows, file order, PR metadata, branch, and hashes, deep-equals across calls

#### Scenario: Changed disposition content changes branch

- **WHEN** a session keeps the same ID but its final sanitized bytes change
- **THEN** the content digest and contribution branch suffix change

#### Scenario: Single and multi wording remains accurate

- **WHEN** N=1 or N>1 is compiled
- **THEN** human-facing title/body/commit wording accurately reflects the record count while retaining the same provenance, attestation, and consent contract

### Requirement: Bundle is target-independent downstream interface

The bundle SHALL include target-independent `branch`, `commitMessage`, `prTitle`, `prBody`, records, exact files, byte/hash metadata, `contentDigest`, and engine identity sufficient for the publication backend to build a preview and later write and verify the exact contribution. It SHALL NOT include or require a local or absolute path, target repository, target branch, upstream, push repository, remote name or URL, Git/`gh` command, command runner, availability probe, credential, workspace state, or delivery result.

#### Scenario: Compilation runs without delivery configuration

- **WHEN** valid stamped sessions and compiler options are provided without any GitHub target or local clone
- **THEN** the compiler returns a complete contribution bundle without probing Git, `gh`, the filesystem, or the network

#### Scenario: Backend can seal exact content

- **WHEN** the publication backend receives a bundle
- **THEN** it can privately retain `files[].contents`, expose safe file/hash summaries, and later detect content drift by recompiling and comparing `contractVersion` plus `contentDigest`, without reconstructing publisher bytes itself
