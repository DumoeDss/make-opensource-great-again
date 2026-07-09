## ADDED Requirements

### Requirement: Disposition application covers session identity fields

The apply engine SHALL be able to read and write the session identity/provenance string fields the widened scan now covers — `schemaVersion`, `session.sessionId`, `session.sourceId`, `session.projectKey`, and the `meta` string fields `contributorAlias`/`sourceCli`/`toolVersion`/`exportedAt`/`license` — so that a human `replace` or `delete` disposition of a finding in one of those fields is actually applied to the output session. A `replace`/`delete` disposition on a covered field SHALL NOT silently no-op (which would unlock the gate while leaving the raw value — a real secret — in the exported bytes). Fields that are not strings (`session.updatedAt` number, `meta.sanitized` boolean) have no writer; a finding on them is acknowledge-only.

#### Scenario: Replacing a secret found in projectKey lands in the output

- **WHEN** a finding in `session.projectKey` is dispositioned `replace`
- **THEN** the output session's `session.projectKey` has the matched span replaced and the input session is unchanged

#### Scenario: Encoded project-key path pseudonymizes on apply

- **WHEN** the non-blocking L3 `path` finding over an encoded `session.projectKey` slug is dispositioned `replace`
- **THEN** the output `session.projectKey` is the `<PATH_n>` placeholder, so the username/project directory embedded in the slug is not exported

### Requirement: Provenance fields are never auto-mutated by sanitization

The apply engine SHALL NOT sanitize or rewrite provenance on its own initiative. It edits a covered field only when a human sets an explicit `replace`/`delete` disposition on a finding in that field; under normal operation these tool-controlled fields carry no findings and pass through byte-identical. The two authoritative stamps — `meta.sanitizationRulesetVersion` and `meta.contributorAlias` — SHALL continue to be written only by the stamping step at gate-unlock (from the report's ruleset version and the mapper's primary alias), which is the intended provenance-writing mechanism, not a sanitization edit. The publisher-side `sanitizerPackageVersion` is not part of the `SanitizedSession` envelope, is never scanned or mutated here, and remains authoritative at publish time.

#### Scenario: Untouched provenance passes through unchanged

- **WHEN** a session with no findings in its provenance fields is applied and stamped
- **THEN** `meta.toolVersion`, `meta.exportedAt`, `meta.sourceCli`, `session.sourceId`, and `schemaVersion` are byte-identical to the input, and only `meta.sanitized`, `meta.sanitizationRulesetVersion`, and `meta.contributorAlias` are set by the stamp

#### Scenario: Stamp overrides any human edit to the stamped fields

- **WHEN** apply runs and the gate is unlocked
- **THEN** `meta.sanitizationRulesetVersion` equals the report's ruleset version and `meta.contributorAlias` equals the mapper's primary-username placeholder, regardless of any disposition set on those fields
