# Tasks — mosga-v02-sanitizer-coverage

## 1. Schema: FindingField additions

- [x] 1.1 Add the session-scope enum values to `FindingFieldSchema` in `packages/sanitizer/src/schemas.ts`: `schemaVersion`, `metaContributorAlias`, `metaSourceCli`, `metaToolVersion`, `metaExportedAt`, `metaLicense`, `sessionId`, `sessionSourceId`, `sessionProjectKey`, `sessionUpdatedAt`. Keep them documented as session-level, non-message fields.
- [x] 1.2 Confirm the additive change typechecks against `@mosga/ui` and `@mosga/publisher` (they import `FindingField` as a type; `describeLocation` handles session scope generically).

## 2. Scan: widen `collectScanUnits`

- [x] 2.1 In `packages/sanitizer/src/scan.ts`, emit a session-scope `ScanUnit` for each new string field: `schemaVersion`; `meta.contributorAlias`, `meta.sourceCli`, `meta.toolVersion`, `meta.exportedAt`, `meta.license` (skip when null); `session.sessionId`, `session.sourceId`, `session.projectKey`; and `session.updatedAt` coerced via `String(...)`. Skip `meta.sanitized` (boolean) and `meta.sanitizationRulesetVersion` (null at scan) — documented as byte-backstop-only.
- [x] 2.2 Verify the new units flow through the existing per-`ScanUnit` L1/L2/L3 loop unchanged, so the 250 ms/field budget, 200 k cap, and `redos-guard` finding already apply to them.

## 3. Scan: encoded project-key pseudonymization

- [x] 3.1 Add field-scoped recognition of an encoded home-path slug (a `Users`/`home` segment in dash-encoded position) applied ONLY to the `sessionProjectKey` unit — never to arbitrary text. On match, emit a non-blocking L3 `normalization` finding of category `path` covering the slug, with the session `PseudonymMapper` `<PATH_n>` placeholder as `replacementSuggestion`. Reuse the existing `path` category; add no new `NormalizationCategory`.
- [x] 3.2 Keep the recognition regex bounded/linear (no catastrophic backtracking) so it respects the ReDoS posture.

## 4. Apply: read/write the new fields

- [x] 4.1 Extend `readField`/`writeField` in `packages/sanitizer/src/apply.ts` for the new **string** session fields (`schemaVersion`, `sessionId`, `sessionSourceId`, `sessionProjectKey`, and the `meta*` string fields) so a `replace`/`delete` disposition lands and never silently no-ops. Do NOT add a writer for `sessionUpdatedAt` (number).
- [x] 4.2 Confirm the stamping step still authoritatively sets `meta.sanitizationRulesetVersion` and `meta.contributorAlias` at gate-unlock, overriding any disposition on those fields (provenance-writing mechanism unchanged).

## 5. Tests: scan coverage (regression, the core deliverable)

- [x] 5.1 Fixture with a planted fake secret in `session.projectKey` → assert a blocking `secrets` finding with `location.field === 'sessionProjectKey'` and `gate.blockingPending > 0`. All fixture secrets are obviously-fake, non-functional values.
- [x] 5.2 Same for a planted secret in `session.sessionId`, `session.sourceId`, `meta.toolVersion`, `meta.contributorAlias`, `meta.exportedAt`, `meta.license`, and top-level `schemaVersion` — each yields a blocking finding at its `location.field`.
- [x] 5.3 Assert `meta.sanitized` (boolean) and a `null` field produce no structured finding (documented backstop-only coverage), and that `session.updatedAt` is scanned via its string coercion.
- [x] 5.4 ReDoS/oversize: an oversized `session.projectKey` emits the `redos-guard` blocking finding rather than being skipped.

## 6. Tests: projectKey pseudonymization + apply

- [x] 6.1 `session.projectKey = '-Users-alice-acme-secret'` (and a `C--Users-…` Windows form) → assert a non-blocking L3 `path` finding over the slug with a `<PATH_n>` `replacementSuggestion`.
- [x] 6.2 Session-consistency: the same path in `session.cwd` and `session.projectKey` resolves to the same `<PATH_n>` placeholder.
- [x] 6.3 Apply: dispositioning the projectKey `path` finding `replace` yields an output `session.projectKey` equal to the `<PATH_n>` placeholder (username/project dir not exported); input session unchanged.
- [x] 6.4 No-op-leak guard: a `replace` on a projectKey secret finding changes the output bytes (proves the writer is wired).

## 7. Tests: provenance immutability

- [x] 7.1 Pass-through: a session with no findings in provenance fields, after apply+stamp, has `meta.toolVersion`/`meta.exportedAt`/`meta.sourceCli`/`session.sourceId`/`schemaVersion` byte-identical to input; only `meta.sanitized`/`meta.sanitizationRulesetVersion`/`meta.contributorAlias` are set by the stamp.
- [x] 7.2 Stamp-override: `meta.contributorAlias` and `meta.sanitizationRulesetVersion` equal the mapper alias and report ruleset version regardless of any disposition set on them.

## 8. Tests: review-gate data-flow visibility (daemon)

- [x] 8.1 In `packages/daemon`, a review created over a session carrying a planted secret in `session.projectKey`/`meta.*` returns that blocking finding in the `POST /api/reviews` report and keeps `gate.unlocked === false` — proving the widened coverage reaches the human review gate, not just the sanitizer unit boundary.

## 9. Validate + record

- [x] 9.1 `npm run typecheck` / build across affected packages (`sanitizer`, `daemon`, `ui`, `publisher`) and run `vitest` — all green.
- [x] 9.2 `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v02-sanitizer-coverage --json` passes.
