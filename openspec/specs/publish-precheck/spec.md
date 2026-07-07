# publish-precheck

## Purpose

Defines the `@mosga/publisher` mandatory local pre-check: an independent, defense-in-depth re-scan of the exact bytes about to be published — including a raw-bytes backstop pass covering fields the structure-aware scanner does not visit — that hard-refuses publication on any surviving blocking finding.

## Requirements

### Requirement: Mandatory pre-check re-scans the artifact bytes

Before any output file or PR is produced, the publisher SHALL re-run the `@mosga/sanitizer` scan on the exact artifact about to be published, parsed back as a `SanitizedSession`, using a ruleset compiled from the same vendored gitleaks pin (and trusted local custom rules) the review daemon uses. The pre-check SHALL be independent of the human gate — it verifies the final bytes, not the recorded human decisions.

The pre-check SHALL cover **100% of the serialized published bytes**, not merely the subset of fields the structure-aware scanner traverses. In addition to the structured `scanSession` pass, the publisher SHALL run the same compiled secret/custom ruleset over the exact serialized record as a structure-agnostic raw-bytes backstop, so a blocking finding in ANY field — including `meta.*`, `schemaVersion`, and `session.{sessionId,sourceId,projectKey,updatedAt}`, which the structured traversal never visits — still refuses publication.

#### Scenario: Pre-check runs the shared ruleset on the final record

- **WHEN** the publisher is asked to publish an exported record
- **THEN** it re-scans that record with `scanSession` using the shared compiled ruleset before producing any output

#### Scenario: A secret in a field the structured scanner does not visit is still caught

- **WHEN** a blocking secret is present in a field outside the structure-aware traversal (e.g. `meta.toolVersion`, `meta.contributorAlias`, `session.projectKey`, or `schemaVersion`)
- **THEN** the raw-bytes backstop detects it and the publisher refuses publication (no file, no PR)

### Requirement: Hard-refuse on any surviving blocking finding

If the pre-check scan yields ANY blocking finding — `secrets`, `custom`, `redos-guard`, or `ruleset-compile-error` — the publisher SHALL refuse: it writes no output file, prepares no PR, and reports which findings blocked. Only a scan with zero blocking findings SHALL proceed.

#### Scenario: A surviving canary secret refuses publication

- **WHEN** the artifact still contains a (fake) secret that the shared ruleset detects
- **THEN** the publisher refuses to produce any publishable file or PR and reports the blocking finding(s)

#### Scenario: A clean artifact proceeds

- **WHEN** the pre-check scan of a fully-sanitized artifact yields zero blocking findings
- **THEN** the publisher proceeds to produce the output / prepare the PR

#### Scenario: A human-allowed real secret is still caught

- **WHEN** a real secret was marked `allow` upstream but remains present in the artifact bytes
- **THEN** the pre-check re-detects it as a blocking finding and refuses publication (defense-in-depth over the gate)

### Requirement: Non-blocking findings do not block publication

The pre-check SHALL NOT refuse on Layer-3 `normalization` (non-blocking) findings; only blocking findings gate publication. This mirrors the gate semantics (L3 is statistics + sampling, not a hard block).

#### Scenario: Residual normalization hit does not block

- **WHEN** the pre-check finds only non-blocking normalization findings (e.g. a placeholder or an allowed path)
- **THEN** publication proceeds

### Requirement: Pre-check parity with CI is version-pinned

The pre-check SHALL surface the `@mosga/sanitizer` package version, the `rulesetVersion`, and the gitleaks pin it used, so the community CI can pin the identical engine and the local verdict and the CI verdict are guaranteed to match. A rules or engine version the CI cannot match SHALL be a visible failure, never a silent divergence.

#### Scenario: Pre-check reports the engine + ruleset version it used

- **WHEN** the pre-check runs
- **THEN** it reports the sanitizer package version, ruleset version, and gitleaks pin used, matching what the CI template pins
