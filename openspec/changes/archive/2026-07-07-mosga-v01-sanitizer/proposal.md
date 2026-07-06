## Why

The pipeline can now discover and parse Claude Code sessions into the `SanitizedSession` envelope (`sanitized:false`), but that envelope still carries raw secrets, company code identifiers, local paths, usernames, emails, and IPs — publishing it as-is would leak exactly what the project's credibility depends on protecting. This slice builds `@mosga/sanitizer`: the multi-layer detection + human-dispositioned redaction core that turns a raw envelope into one safe to review and export. It is slice 2 of 4; its findings/report model is consumed by slice 3's review UI and its ruleset artifact is consumed by slice 4's CI pre-check (the design doc's shared "验证防线").

## What Changes

- Add `@mosga/sanitizer`, depending on `@mosga/contracts` and `@mosga/session-readers`, providing ruleset ingestion, a three-layer structure-aware scan, a findings/report model, and a disposition/apply engine.
- **Gitleaks ruleset ingestion**: vendor the gitleaks TOML ruleset at a pinned version, parse it, and translate each Go RE2 pattern to a JS `RegExp` behind a compatibility validator. Rules that cannot be faithfully translated are **explicitly listed and degraded** (to keyword/literal or disabled-with-reason) — NEVER silently dropped (design-doc ban on silent truncation). Emit a compiled ruleset artifact that both the tool and slice-4 CI load, so both defenses run the identical rule set.
- **User custom rules** (Layer 2): load a user rules file of regex or literal-string entries.
- **Three-layer scan** over `ParsedMessage[]`: L1 secrets (gitleaks) block-on-hit, L2 custom rules block-on-hit, L3 normalization (paths / usernames / emails / IPs) with a **session-scoped deterministic pseudonym mapping** (same value → same placeholder within a session; the SAME value maps differently across sessions, defeating cross-session linking).
- **Structure-aware traversal**: scan the high-risk structural positions the design doc calls out — message content, thinking, command fields, tool-call inputs, and (highest risk) tool-call results / command echoes — recording each hit's precise structural location, not just a flat offset.
- **Findings / report model**: a per-hit record `{ layer, ruleId, location, span, matchPreview, replacementSuggestion, disposition, blocking }` plus layer summaries, a gate-status computation (L1/L2 未清零不解锁), and a non-text-items list carried from readers' `nonTextContent` markers. This report object is the contract slice 3 renders and slice 4 re-checks.
- **Disposition / apply engine**: per-hit replace / delete / allow, plus batch-by-rule and batch-by-type, all using the same deterministic pseudonym mapping so identical hits collapse to identical placeholders. Produces a sanitized `SanitizedSession` with `meta.sanitized = true` and `meta.sanitizationRulesetVersion` stamped.
- **Non-text handling**: the sanitizer does NOT strip non-text content; it propagates every `nonTextContent` marker (including those the reader resolved onto tool-call messages) into the report as items requiring per-item human confirmation.
- **Canary + false-positive tests**: hand-crafted fake secrets (obviously-fake AWS / GitHub / generic patterns) at multiple structural positions that MUST be caught, plus false-positive-guard tests (e.g. the AWS docs example key) that MUST be suppressed.

## Capabilities

### New Capabilities

- `ruleset-ingestion`: vendor + parse + RE2→JS-translate + validate the gitleaks ruleset, load user custom rules, and emit the compiled shared-ruleset artifact (with an explicit degradation manifest). The rule supply that both the tool and CI consume.
- `sanitization-scan`: structure-aware traversal of `SanitizedSession.messages` (+ session-level strings) applying the three layers, the session-scoped deterministic pseudonym mapper, and producing the findings/report model (with non-text items and gate status).
- `sanitization-apply`: the disposition/apply engine — per-hit and batch replace/delete/allow using the shared pseudonym mapping, the block-on-hit gate function, and emission of the stamped sanitized `SanitizedSession`.

### Modified Capabilities

<!-- None. `openspec/specs/` is empty (readers not yet archived); sanitizer's shared schemas are new capabilities exported from @mosga/sanitizer, not modifications to the readers' session-contracts spec. -->

## Impact

- **New package**: `packages/sanitizer/` (`@mosga/sanitizer`), plus a vendored gitleaks TOML under it (pinned) and a generated compiled-ruleset JSON artifact.
- **New dependencies**: a TOML parser (`smol-toml`, ESM) for gitleaks-config parsing; `zod` (report/rule schemas); dev `vitest`. No network at runtime — the gitleaks config is vendored, not fetched.
- **Consumes**: `@mosga/contracts` (`SanitizedSession`, `ParsedMessage`, `NonTextContentMarker`, `ToolCall`) and `@mosga/session-readers` (the `nonTextContent` marker semantics, including tool-call-resolved markers).
- **Downstream contract**: slice 3 (`@mosga/daemon` + `@mosga/ui`) renders the `SanitizationReport` and drives dispositions; slice 4 (`@mosga/publisher` + CI) re-runs the scan from the SAME compiled ruleset artifact as the verification defense. Report model, ruleset file format, and apply API fixed here are load-bearing for both.
- **Out of scope** (later slices, must not bleed in): the review UI / daemon / gate ENFORCEMENT UX (slice 3), and publishing / GitHub PR / CI workflow wiring (slice 4 — but the compiled ruleset artifact format must be CI-consumable). No export-schema slicing here.
