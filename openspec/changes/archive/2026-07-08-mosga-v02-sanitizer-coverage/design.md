# Design — mosga-v02-sanitizer-coverage

## Context

`scanSession` (`packages/sanitizer/src/scan.ts`) drives all human-visible detection: the daemon's `POST /api/reviews` runs it, stores `{ session, report, mapper }` by `reviewId`, and the React UI renders `report.findings`. The gate (`computeGate`) locks export while any blocking finding is `pending`. So **whatever `collectScanUnits` does not visit is invisible to the human gate.**

Today `collectScanUnits` visits: per-message `content`/`thinking`/`command*`/`toolCalls[].input`/`toolCalls[].result`/`toolResults[].content`; per-session `cwd`/`title`. It skips `schemaVersion`, all of `meta.*`, and `session.{sessionId, sourceId, projectKey, updatedAt}`.

The publisher already knows this gap. `precheck.ts` finding **B1** adds `scanRawBytesBackstop`, which re-scans the exact serialized bytes so a secret in any skipped field still refuses **出口①** publication. But that backstop is publish-path-only; **出口②** (slice 2, API replay) is a new exit with no backstop yet (slice 2 will add an equivalent). The review gate is the defense both exits share, so its coverage must be closed first. That is this slice.

## Goals / Non-goals

- **Goal**: every string-bearing envelope field is scanned; a planted secret there becomes a blocking finding visible to the review-gate data flow.
- **Goal**: `session.projectKey` (username + project dir, dash-encoded) is pseudonymizable, not just secret-scanned.
- **Goal**: a human disposition on a newly covered field actually applies (no silent no-op leak).
- **Non-goal**: replacing or weakening the raw-bytes backstop — it stays as the byte-exact last line, and remains the coverage for non-string fields.
- **Non-goal**: new `NormalizationCategory` values, new mapper mechanics, or touching slice-2/slice-3 surfaces.

## Field-by-field decision

Fields fall into four buckets by risk and semantics. "Scanned" = L1 secrets + L2 custom + L3 normalization run over it (secrets/custom are always `blocking:true` by layer). "Writable" = `apply.readField`/`writeField` handle it so a `replace`/`delete` lands.

| Field | Bucket | Scan | L3 pseudonymize | Writable | Rationale |
| --- | --- | --- | --- | --- | --- |
| `session.projectKey` | Identity (high risk) | yes | yes — encoded home-path slug → `<PATH_n>` | yes | Embeds OS username + project dir in a dash-encoded slug the slash-anchored detectors miss. Highest-value addition. |
| `session.sessionId` | Identity (low PII) | yes (block-only) | no | yes | Normally a random UUID: not PII, not a secret. Pseudonymizing it would break the publisher's deterministic filename `data/…/<sessionId>.jsonl` for zero privacy gain. Writable only so a *planted* secret can be removed. |
| `session.sourceId` | Tool-controlled | yes (block-only) | no | yes | `"claude-code"`. No PII; scanned for defense-in-depth; writable to avoid a no-op leak. |
| `session.cwd` / `session.title` | (already covered) | yes | yes (unchanged) | yes (unchanged) | No change; listed for completeness. |
| `session.updatedAt` | Timestamp (number) | yes (coerced to string, block-only) | no | no (number) | A number cannot encode a secret as text; scanned for completeness only. No writer (writing a string back would break the type). A finding here is pathological → acknowledge-only. |
| `schemaVersion` | Provenance (string) | yes (block-only) | no | yes | `"0.1.0"`. Scanned defense-in-depth; writable to avoid no-op leak; never auto-mutated. |
| `meta.contributorAlias` | Provenance (stamped) | yes (block-only) | no | yes | `<CONTRIBUTOR>` at scan input; **overwritten at stamp** by `mapper.primaryContributorAlias()`. Scanned in case a reader ever put a raw username here; the stamp is authoritative. |
| `meta.sourceCli` | Provenance | yes (block-only) | no | yes | `"claude-code"` enum. Same as sourceId. |
| `meta.toolVersion` | Provenance | yes (block-only) | no | yes | Tool version. Scanned defense-in-depth; never auto-mutated. |
| `meta.exportedAt` | Provenance | yes (block-only) | no | yes | ISO timestamp. Same. |
| `meta.license` | Provenance | yes (block-only, skip if null) | no | yes | License string or null. Same. |
| `meta.sanitizationRulesetVersion` | Provenance (stamped) | skip (null at scan) | — | — | `null` out of readers; the stamp sets it. Nothing to scan. Byte-backstop covers the stamped value. |
| `meta.sanitized` | Provenance (boolean) | skip | — | — | Boolean cannot encode a secret. Byte-backstop covers the literal `false`. |

### Why "block-only, writable" for the tool-controlled fields

Two forces:
1. **Coverage**: the gate must lock if a secret ever lands in these fields (matching the byte-backstop). L1/L2 findings are `blocking:true` by construction, so scanning them achieves this for free.
2. **No silent no-op leak**: if a field is scanned but *not* writable, a human choosing `replace` on a finding there would no-op — disposition becomes non-`pending`, the gate unlocks, and the raw value (the real secret) exports. So every scanned **string** field gets a writer. `updatedAt` (number) is the one exception; a finding there is pathological and acknowledge-only, and the byte-backstop still guards export.

"Writable" does **not** mean auto-mutated. `apply` edits a field only on an explicit human `replace`/`delete` of an actual finding. Under normal operation these fields carry no findings and pass through byte-identical — verified by a pass-through test.

## Provenance that must NOT be sanitized/mutated — and why it is safe

- **`sanitizerPackageVersion`**: not a `SanitizedSession` field at all. It lives in the publisher's `EngineInfo` stamp (`precheck.ts`), computed at publish time from `@mosga/sanitizer`'s `package.json`. This slice never scans or touches it. Safe because it is tool-derived provenance the community CI pins against for engine parity; mutating it would falsify that parity.
- **`meta.sanitizationRulesetVersion` and `meta.contributorAlias`**: written **only** by the stamping step at gate-unlock, from the report's ruleset version and the mapper's primary alias. That is the intended provenance-writing mechanism, not a sanitization edit, and the stamp overrides any human disposition on those fields. Safe because the values are authoritative outputs of the pipeline, not user data.
- **`meta.sanitized` / `session.updatedAt`**: non-string; not sanitizable as text, no writer. Safe because a boolean/number cannot carry a secret, and the byte-exact backstop still scans their literal serialization.

## The projectKey pseudonymization mechanism

`encodeProjectPath` maps non-alphanumerics to `-`, so `/Users/alice/acme-secret` → `-Users-alice-acme-secret` and `C:\Users\alice\acme` → `C--Users-alice-acme`. The L3 `PATH_RE`/`USERNAME_RE` detectors are anchored on `\Users\` / `/home/` / `/Users/` with real separators, so they do **not** fire on the dash form. Two options considered:

1. **Extend `PATH_RE` globally to also match the dash-encoded slug.** Rejected: dashes are lossy and appear in ordinary prose/identifiers, so a global dash-slug pattern over all message text would over-match and flood L3.
2. **Field-scoped recognition (chosen).** Only when scanning the `projectKey` field, test for an encoded home marker (a `Users`/`home` segment in dash-encoded position); if present, emit a single non-blocking L3 `path` finding covering the whole slug with the mapper's `<PATH_n>` placeholder. Scoped to one field, it cannot touch prose, and it reuses the existing `path` category + existing apply in-text replacement — **no new `NormalizationCategory`, no mapper change, no schema ripple beyond the `FindingField` additions.**

This makes `projectKey` exactly parallel to `cwd`: L1/L2 block-on-hit, L3 `path` non-blocking pseudonymization. Session-scoped mapper consistency means if the same path is in both `cwd` and `projectKey` they collapse to the same `<PATH_n>` (and stay cross-session-inconsistent by the mapper's first-encounter ordering — the D6 anti-linking guarantee is preserved, deliberately **not** turning projectKey into a stable cross-session grouping key).

## FindingField additions

Additive enum values on `FindingFieldSchema`, all `scope:'session'`:
`schemaVersion`, `metaContributorAlias`, `metaSourceCli`, `metaToolVersion`, `metaExportedAt`, `metaLicense`, `sessionId`, `sessionSourceId`, `sessionProjectKey`, `sessionUpdatedAt`.

`describeLocation` (UI) already renders session-scope fields as `session.<field>` generically, so these surface in the gate table with no UI change. (`session.sessionProjectKey` reads slightly redundantly, consistent with the existing `session.sessionCwd`; a nicer label is an optional future UI polish, not in scope.)

## Alternatives considered

- **Rely on the raw-bytes backstop alone.** Rejected: the backstop is publish-path-only and byte-level (no field attribution, no human disposition), and 出口② has none yet. The human must *see* the hit and act, which requires structured findings.
- **Hash-style whole-field pseudonymization of projectKey/sessionId via a new mapper category.** Rejected as over-scoped: it would touch `NormalizationCategorySchema` (a cross-slice enum rippling to UI/publisher) and invent new mapper mechanics. The field-scoped `path`-category reuse achieves projectKey pseudonymization with zero new categories, and sessionId is intentionally left un-pseudonymized (UUID, not PII; pseudonymizing breaks the publisher filename).

## Risks

- **Enum ripple**: adding `FindingField` values changes an exported type consumers import. Mitigated: purely additive; `describeLocation` is generic; typecheck the daemon/ui/publisher packages after the change.
- **False positives in provenance fields**: a generic-token gitleaks rule could trip on a version-like string. Mitigated: block-only + human `allow`; and the byte-backstop already scans these same bytes today, so this change does not introduce a *new* false-positive surface for 出口① — it makes the same hits human-visible earlier.
- **No-op-leak regression**: covered by an explicit test asserting a `replace` on a projectKey finding changes the output bytes.
