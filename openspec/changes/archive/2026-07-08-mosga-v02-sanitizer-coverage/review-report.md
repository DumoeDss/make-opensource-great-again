# Review Report — mosga-v02-sanitizer-coverage

**Reviewer:** reviewer-1 (not the author)
**Date:** 2026-07-09
**Scope:** uncommitted working-tree diff — `packages/sanitizer/src/{scan.ts,apply.ts,schemas.ts,detectors.ts}` + new tests `packages/sanitizer/src/__tests__/scan-envelope.test.ts`, `packages/daemon/src/__tests__/envelope-coverage.test.ts`
**Reviewed against:** `proposal.md`, `design.md` (field-semantics table), `tasks.md`, `specs/sanitization-{scan,apply}/spec.md`, `openspec/changes/mosga-v02/planning-context.md` (slice 1)

---

## VERDICT: CLEAN — 0 Blockers, 0 Major, 0 Minor, 2 Trivial (informational)

The change faithfully implements the slice-1 spec. Every field in the design semantics table receives exactly the specified treatment; the projectKey recognizer is correct and bounded; there is no no-op leak; provenance immutability and stamp-override hold; pseudonym consistency is preserved; the ReDoS posture carries over. Both Trivial notes below are theoretical and require no action.

**Evidence of green build (run during review):**
- `npm run typecheck` — clean across all 6 packages (contracts, session-readers, sanitizer, ui, daemon, publisher).
- `npx vitest run` — 32 files / 155 tests pass (includes the 12 new envelope tests).
- `rasen validate mosga-v02-sanitizer-coverage --json` — 1/1 passed.
- `git status` confirms only the 4 sanitizer files + 2 new tests changed; `packages/publisher/src/precheck.ts` backstop and archived artifacts are untouched.

---

## Spec axis — field-by-field conformance (design.md table)

Every string-bearing envelope field gets its specified semantics. No field is silently missing.

| Field | Spec: scan | Spec: L3 pseud. | Spec: writable | Implemented | OK |
| --- | --- | --- | --- | --- | --- |
| `session.projectKey` | yes | yes (encoded slug) | yes | scan unit + bespoke `path` finding (`scan.ts:71,438-453`), writer (`apply.ts:240,300`) | ✓ |
| `session.sessionId` | yes (block-only) | no | yes | scan unit (`scan.ts:69`), writer (`apply.ts:242,303`) | ✓ |
| `session.sourceId` | yes (block-only) | no | yes | scan unit (`scan.ts:70`), writer (`apply.ts:244,306`) | ✓ |
| `session.updatedAt` | yes (coerced, block-only) | no | **no** (number) | coerced unit (`scan.ts:78`), no writer (default arm `apply.ts:258-261,330-332`) | ✓ |
| `schemaVersion` | yes (block-only) | no | yes | scan unit (`scan.ts:63`), writer (`apply.ts:246,309`) | ✓ |
| `meta.contributorAlias` | yes (block-only) | no | yes, stamp-authoritative | scan unit (`scan.ts:64`), writer (`apply.ts:248,312`), stamp override (`apply.ts:218`) | ✓ |
| `meta.sourceCli` | yes (block-only) | no | yes | scan unit (`scan.ts:65`), writer w/ documented cast (`apply.ts:250,318`) | ✓ |
| `meta.toolVersion` | yes (block-only) | no | yes | scan unit (`scan.ts:66`), writer (`apply.ts:252,321`) | ✓ |
| `meta.exportedAt` | yes (block-only) | no | yes | scan unit (`scan.ts:67`), writer (`apply.ts:254,324`) | ✓ |
| `meta.license` | yes (skip null) | no | yes | scan unit skipped when falsy (`scan.ts:68,73`), writer (`apply.ts:256,327`) | ✓ |
| `meta.sanitizationRulesetVersion` | skip (stamp-set) | — | — | not scanned; stamped (`apply.ts:217`) | ✓ |
| `meta.sanitized` | skip (boolean) | — | — | not scanned; stamped (`apply.ts:216`) | ✓ |

- **FindingField enum** (`schemas.ts:140-152`): all 10 spec-listed values added, additive/non-breaking. Enum-completeness check across consumers — the only consumer that reads `location.field` is `packages/ui/src/lib/findings.ts`: `describeLocation` renders session scope generically as `session.${field}` (`findings.ts:22-23`) and `isMetaFinding` keys on `ruleId`/`rulesetMeta` only (`findings.ts:11-16`), so the new values need no per-value handling. No `switch`/allowlist in ui/publisher/daemon branches on these values. UI + publisher typecheck clean.
- **No no-op leak**: every scannable+writable string field has a real writer that mutates output bytes; asserted by test 6.4 (`scan-envelope.test.ts:138-151`). Correctly no writer for `sessionUpdatedAt` (number) and `rulesetMeta` (non-span).
- **Provenance immutability**: pass-through byte-identity asserted (test 7.1); stamp overrides any disposition on `contributorAlias`/`sanitizationRulesetVersion` (test 7.2, `apply.ts:213-219`).

### projectKey recognizer (`detectors.ts:56-69`)
- `ENCODED_HOME_SLUG_RE = /(?:^|-)(?:Users|home)-[^-\s]/` correctly matches both the POSIX-origin form `-Users-alice-...` and the Windows-origin form `C--Users-...` (the `C-` prefix is consumed by the `-` alternative). Verified by parametrized test 6.1.
- **Linear / no catastrophic backtracking**: no nested quantifiers; single character-class step. `.replace(/-/g, '/')` is linear. ReDoS posture respected.
- **Field-scoped**: invoked only under `unit.field === 'sessionProjectKey'` (`scan.ts:438`); `decodeEncodedProjectKey` is not called anywhere else. Never runs over generic message text — cannot over-match prose.
- **Pseudonym consistency**: POSIX decode `-Users-alice-acme` → `/Users/alice/acme` collapses to the same `<PATH_n>` the `cwd` PATH_RE detector produces for `/Users/alice/acme` (shared per-scan `PseudonymMapper`); asserted by test 6.2. Mapper statefulness is per-`scanSession` instance and per-`reviewId` in the daemon — unchanged by this diff.

### ReDoS posture
New fields flow through the same per-`ScanUnit` L1/L2/L3 loop, inheriting the 250 ms budget and 200k cap and the `redos-guard` blocking finding (test 5.4 asserts an oversized projectKey emits `redos-guard`). No new unbounded regex introduced.

### Review-gate data flow
Daemon test 8.1 drives a real `POST /api/reviews` with a secret-bearing project slug and asserts the blocking `sessionProjectKey` finding appears in the returned report with `gate.unlocked === false` — proving coverage reaches the human gate, not just the sanitizer unit boundary. Test is honest (planted secret is the obviously-fake `FAKE_GITHUB_PAT` canary; assertion is on real returned data).

---

## Standards axis

No smell-baseline or checklist violations. The `readField`/`writeField` switches mirror the existing message-field switches (consistent local idiom, not new Repeated-Switches debt). Comments state constraints (why the `sourceCli` cast, why no writer for numbers) rather than narrating. Test secrets are the shared fake canary.

---

## Trivial notes (informational only — no action required)

1. **`scan.ts:439` decodes `full` (untruncated), not `text` (200k-capped).** For the bespoke projectKey pseudonymization block, `decodeEncodedProjectKey(full)` and `matchPreview: full` operate on the untruncated string, unlike the L1/L2/L3 loop which scans the capped `text`. Consequence only for a pathological >200k-char projectKey that is *also* a valid `Users`/`home` slug: a large `matchPreview` in the report and a large mapper key. This is theoretical — real `projectKey` values are filesystem-path-bounded (~260 chars Windows / 4096 Linux) and can never approach the cap — and the operations are linear (no ReDoS), and the `redos-guard` blocking finding still fires (`truncated === true`) to lock the gate. Left as-is is defensible.

2. **L3 detectors run over every envelope unit, including `sessionId`/provenance** (the design table marks their "L3 pseudonymize" column "no"). This matches design.md's own definition of "Scanned" (L1+L2+L3), and the "no" means "no bespoke pseudonymization mechanism" (only projectKey gets one). For the real values — UUIDs, `claude-code`, version strings, ISO timestamps — no L3 detector fires (verified: the `...T00:00:00.000Z` timestamp does not trip `IPV6_RE`, as the time segment lacks a leading word boundary). A non-blocking L3 hit on `sessionId` is therefore practically impossible and, were it to occur, is non-blocking and human-dismissable. No behavioral defect.

---

## Tasks checklist

All tasks 1.1–9.2 are implemented and verified against the code and passing tests. Tasks marked `[x]` in `tasks.md` are accurate.
