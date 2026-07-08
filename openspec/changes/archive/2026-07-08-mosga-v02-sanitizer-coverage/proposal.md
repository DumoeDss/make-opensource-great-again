## Why

The structured scanner (`collectScanUnits` in `packages/sanitizer/src/scan.ts`) only visits message bodies plus `session.cwd`/`session.title`. It never reaches `schemaVersion`, `meta.*`, or `session.{sessionId, sourceId, projectKey, updatedAt}`. A secret planted in any of those fields produces **no finding**, so the human review gate (which renders the structured `SanitizationReport`) never shows it and never locks on it. This gap is already documented in `packages/publisher/src/precheck.ts` (finding **B1**): the publish path bolts on a `scanRawBytesBackstop` that re-scans the exact bytes to cover exactly these fields.

That backstop only protects **出口① (dataset PR export)**. v0.2 is about to open **出口② (API direct-submit/replay)**, a second data exit. Before opening it, the coverage the human sees must generalize across both exits — the review gate is the one defense both exits share. `session.projectKey` in particular embeds the OS username **and** the (possibly proprietary) project directory name in an encoded slug, and it is currently invisible to the gate. Closing this gap now is what makes the v0.2 security narrative self-consistent.

## What Changes

- **Widen `collectScanUnits`** to emit scan units for the previously skipped string-bearing envelope fields: `schemaVersion`; `meta.contributorAlias`, `meta.sourceCli`, `meta.toolVersion`, `meta.exportedAt`, `meta.license`; and `session.sessionId`, `session.sourceId`, `session.projectKey`, `session.updatedAt` (number coerced to string). `null` fields are skipped; `meta.sanitized` (boolean) and `meta.sanitizationRulesetVersion` (null out of readers) are left to the byte-exact backstop.
- **New `FindingField` enum values** (additive, non-breaking) so each hit carries a precise `location.field`. The UI's `describeLocation` renders session-scope fields generically, so they surface in the gate with no UI change required.
- **Encoded project-key pseudonymization**: recognize the dash-encoded home-path shape of `session.projectKey` (which the slash-anchored L3 detectors miss) and emit a non-blocking L3 `path` finding with a `<PATH_n>` placeholder — the same treatment `session.cwd` gets. Recognition is scoped to the `projectKey` field only, so it cannot over-match prose.
- **Extend the apply engine** (`readField`/`writeField`) to read/write the new string fields so a human `replace`/`delete` disposition actually lands, closing a silent-no-op-leak (a no-op replace would unlock the gate while leaving the raw value in the bytes). Provenance is never auto-mutated: edits happen only on explicit human dispositions; the two authoritative stamps stay the stamping step's job.
- **ReDoS guards carry over for free**: the new fields flow through the same per-`ScanUnit` loop, so the 250 ms/field budget and 200 k char cap (and the `redos-guard` finding) already apply.
- **Regression tests**: fixtures with planted fake secrets in each newly covered field assert a blocking finding at the correct `location.field`; a projectKey slug fixture asserts the L3 `path` pseudonym and its apply replacement; provenance pass-through and the stamp override are asserted; a daemon-level review test proves the finding reaches the review-gate data flow (the `POST /api/reviews` report).

## Capabilities

### Modified Capabilities

- `sanitization-scan`: the structure-aware-traversal requirement is widened to include the session identity and provenance envelope fields; new requirements add explicit envelope-field coverage (matching the raw-bytes backstop) and encoded-project-key pseudonymization.
- `sanitization-apply`: new requirements add disposition read/write coverage for the session identity/provenance string fields and codify that provenance is never auto-mutated (only explicit human dispositions edit; the two stamps remain authoritative).

### New Capabilities

<!-- None. This change modifies the existing sanitizer scan/apply capabilities. -->

## Impact

- **Changed source**: `packages/sanitizer/src/scan.ts` (`collectScanUnits`, projectKey L3 handling), `packages/sanitizer/src/schemas.ts` (`FindingFieldSchema` additions), `packages/sanitizer/src/apply.ts` (`readField`/`writeField`), possibly `packages/sanitizer/src/detectors.ts` (encoded-slug recognition helper). New sanitizer tests. A daemon test asserting review-gate visibility.
- **Contract ripple**: `FindingField` is exported from `@mosga/sanitizer` and imported as a type by `@mosga/ui` and `@mosga/publisher`. The change is purely additive (new enum values), and `describeLocation` handles session-scope fields generically, so no consumer breaks.
- **No new dependencies. No network.** Deterministic; existing ReDoS guards apply unchanged.
- **Out of scope** (must not bleed in): 出口② direct-submit itself (slice 2), the Tauri shell (slice 3), any change to the publisher's raw-bytes backstop (it stays as the byte-exact last line), Presidio/LLM PII layers, and any new `NormalizationCategory` (projectKey reuses the existing `path` category).
