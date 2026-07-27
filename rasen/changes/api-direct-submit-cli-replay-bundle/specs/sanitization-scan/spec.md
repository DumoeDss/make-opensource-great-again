## ADDED Requirements

### Requirement: Structure-aware traversal of replay inputs

`@mosga/sanitizer` SHALL expose `scanReplayDraft` alongside the existing `scanSession` API. The replay scanner SHALL visit every string leaf in every retained native JSONL row, every instruction file's content, and every source-derived string stored in source context, terminal-manifest seed, omissions, delivery selection, and aliased placement metadata. It SHALL recurse through unknown objects and arrays without relying on source-specific field allowlists. Validated tool-controlled schema literals, enums, numbers, booleans, null values, and later-derived integrity digests SHALL not require text scanning.

#### Scenario: Secret in an unknown native field is found

- **WHEN** an unknown future JSONL row contains an obviously fake secret under a nested string field
- **THEN** replay scanning emits a blocking finding at that exact native leaf

#### Scenario: Instruction and native data share scan coverage

- **WHEN** a fake sensitive value appears once in a native row and once in `AGENTS.md` content
- **THEN** the report contains distinct findings for both locations under one replay scan

### Requirement: Stable replay finding locations

Replay findings SHALL use an artifact-aware location. A native location SHALL identify logical file id, row ordinal, RFC 6901 JSON Pointer, and character span; an instruction location SHALL identify instruction id and character span; a metadata location SHALL identify a stable payload field path and character span. The scanner SHALL derive `Finding.id` from the stable location and rule id, and a resolver SHALL round-trip each location to the exact matched string and span.

#### Scenario: Native JSON Pointer resolves exactly

- **WHEN** a finding targets `/payload/content/1/text` in native row ordinal 7
- **THEN** resolving its file, ordinal, pointer, and span returns exactly the matched substring

#### Scenario: Replay finding id is stable across a re-scan

- **WHEN** an unchanged ReplayBundle draft is scanned twice with the same ruleset
- **THEN** each corresponding replay finding has the same id

### Requirement: Replay-wide pseudonym and detection semantics

Replay scanning SHALL use the existing compiled L1 secrets, L2 custom, and L3 normalization rules, allowlists, entropy checks, redacted previews, ReDoS/oversize guards, and block-on-hit semantics. One replay-scoped `PseudonymMapper` SHALL be shared across native rows, instruction files, and fixed metadata, so the same `(category, original)` receives the same replacement suggestion everywhere in one draft and is not persisted across drafts.

#### Scenario: Path pseudonym is consistent across artifacts

- **WHEN** the same fake local path appears in a native cwd field and an instruction file
- **THEN** both L3 findings suggest the same `<PATH_n>` value within that replay draft

#### Scenario: Oversize native field does not bypass review

- **WHEN** a native string leaf exceeds the scan-size cap or time budget
- **THEN** the report contains a blocking guard finding rather than silently skipping the unscanned content

### Requirement: Replay opaque and non-text review items

The replay scanner SHALL surface source-recognized non-text or opaque content as replay review items with stable artifact locations and default disposition `pending`. Each pending opaque item SHALL contribute to the replay gate. The scanner SHALL not remove, rewrite, or silently approve the underlying content.

#### Scenario: Native image payload requires a decision

- **WHEN** a captured Claude or Codex content block is recognized as image or other non-text input
- **THEN** replay scanning adds a pending opaque item at the native row/pointer and the gate remains locked

### Requirement: Replay sanitization report and gate

The sanitizer SHALL export a versioned `ReplaySanitizationReport` containing the bundle draft identity, ruleset version, redacted replay findings, opaque items, layer summaries, generated timestamp, and a pure replay gate. The gate SHALL be unlocked only when every blocking finding and every opaque item has a non-pending disposition; L3 normalization findings SHALL remain non-blocking. The report SHALL not persist a full raw secret or the original source absolute path.

#### Scenario: Pending native secret locks replay preparation

- **WHEN** one blocking finding in a native row remains pending
- **THEN** `report.gate.unlocked` is false even if all instruction findings are resolved

#### Scenario: Fully reviewed replay inputs unlock

- **WHEN** all blocking findings and opaque items across native, instruction, and metadata artifacts are dispositioned
- **THEN** the pure replay gate is unlocked regardless of pending non-blocking normalization findings

### Requirement: Existing session scanning remains compatible

Adding replay scanning SHALL NOT change the exported `scanSession`, `SanitizationReport`, `FindingLocation`, or `applyDispositions` behavior for normalized `SanitizedSession` consumers. Shared matcher/refactoring changes MUST keep the existing sanitizer, daemon review, export, and direct-submit backstop test suites green.

#### Scenario: Normalized session scan is unchanged

- **WHEN** an existing `SanitizedSession` fixture is scanned before and after replay scanning is added
- **THEN** it produces the same findings, stable ids, summaries, and gate result
