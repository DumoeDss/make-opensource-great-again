## ADDED Requirements

### Requirement: Vendored, pinned gitleaks ruleset

The `@mosga/sanitizer` package SHALL vendor the gitleaks TOML ruleset at a specific pinned release tag and SHALL NOT fetch it over the network at build or runtime. The pinned gitleaks version SHALL be recorded in the compiled ruleset artifact so it is auditable.

#### Scenario: Ruleset loads from the vendored file offline

- **WHEN** ingestion runs with no network access
- **THEN** it loads the gitleaks rules from the vendored file and records the pinned gitleaks version

#### Scenario: Pinned version is surfaced

- **WHEN** the compiled ruleset artifact is produced
- **THEN** it contains the exact pinned gitleaks release tag it was built from

### Requirement: TOML parsing of gitleaks rules

The package SHALL parse the vendored gitleaks TOML into normalized rule objects, extracting at least `id`, `description`, `regex`, `keywords`, `entropy`, `secretGroup`, and per-rule `allowlist`, plus the global `[allowlist]`.

#### Scenario: A representative rule parses

- **WHEN** a gitleaks rule with `id`, `regex`, `keywords`, and `entropy` is parsed
- **THEN** all of those fields are present on the normalized rule object

#### Scenario: Global allowlist is captured

- **WHEN** the config carries a top-level `[allowlist]` with `regexes` and/or `stopwords`
- **THEN** the global allowlist is captured and applied to all rules during scanning

### Requirement: Go RE2 to JS RegExp translation with a compatibility validator

The package SHALL translate each rule's Go RE2 pattern to a JS `RegExp` through a compatibility validator. It SHALL apply known-safe transforms (at least: named captures `(?P<n>…)` → `(?<n>…)`, POSIX classes, `\A`/`\z`/`\Z` anchors, leading inline flags hoisted to RegExp flags) and SHALL construct the `RegExp` inside error handling so a construction failure is caught, never thrown uncaught.

#### Scenario: A named-capture RE2 pattern translates natively

- **WHEN** a rule regex uses `(?P<secret>…)`
- **THEN** it is translated to `(?<secret>…)` and compiles to a working `RegExp` with `translation.status` of `native` or `translated`

#### Scenario: An untranslatable construct does not throw

- **WHEN** a rule regex uses a construct with no faithful JS equivalent (e.g. a back-reference or mid-pattern inline-flag group)
- **THEN** ingestion catches it and degrades the rule rather than throwing or aborting the whole ingestion

### Requirement: Untranslatable rules are explicitly degraded, never silently dropped

Every rule SHALL end ingestion in exactly one recorded state: `native`, `translated`, `degraded`, or `disabled`. A rule that cannot be faithfully translated SHALL be degraded to a keyword/literal matcher when usable keywords exist, else marked `disabled` with a reason. The compiled artifact SHALL include a `degraded[]` manifest naming every non-`native` rule and why. No rule is ever dropped without a manifest entry (design-doc ban on silent truncation).

#### Scenario: Degraded rule appears in the manifest with a reason

- **WHEN** a rule is degraded to a keyword matcher
- **THEN** the compiled artifact's `degraded[]` list contains that rule id, its resulting status, and a human-readable reason

#### Scenario: Rule count is conserved

- **WHEN** ingestion completes
- **THEN** the count of `native + translated + degraded + disabled` rules equals the count of rules in the vendored TOML (nothing vanished)

### Requirement: User custom rules

The package SHALL load a user custom-rules file whose entries are either a regex pattern or a literal string, each with an `id` and optional `description`/`replacement`. Literal entries SHALL be matched exactly (regex-escaped); regex entries SHALL go through the same compatibility validator as gitleaks rules. Custom rules SHALL be classified as scan Layer 2 (block-on-hit).

#### Scenario: A literal custom rule matches verbatim

- **WHEN** a custom rule is a literal string such as an internal company name
- **THEN** occurrences of that exact string are matched, with regex metacharacters treated literally

#### Scenario: An invalid custom regex is reported, not crashing

- **WHEN** a custom regex entry fails to compile
- **THEN** ingestion reports the offending rule id with an error and continues loading the remaining rules

### Requirement: Compiled shared-ruleset artifact for tool and CI

The package SHALL emit a compiled ruleset artifact (JSON) consumable by BOTH the tool and slice-4 CI, containing a composite `rulesetVersion`, the pinned `gitleaksVersion`, the normalized rules (translated pattern source + flags + keywords + entropy + secretGroup + allowlist + translation state), and the `degraded[]` manifest. The `rulesetVersion` SHALL be a stable composite id that identifies exactly which rules ran, so a report or envelope stamped with it can be checked for parity.

#### Scenario: The same artifact drives both defenses

- **WHEN** the tool and a separate CI process each load the compiled artifact
- **THEN** they obtain an identical rule set (same rules, same translation states, same version), so the local pre-check and the CI re-check are guaranteed equivalent

#### Scenario: rulesetVersion changes when rules change

- **WHEN** the gitleaks pin, the L3 rule version, or the custom-rule set changes
- **THEN** the composite `rulesetVersion` changes so downstream parity checks detect the difference
