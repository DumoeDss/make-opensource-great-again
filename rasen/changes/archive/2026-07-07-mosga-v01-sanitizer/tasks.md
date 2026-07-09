# Tasks — mosga-v01-sanitizer

Ordered, individually completable. Fixtures are ALWAYS hand-crafted fake data; canary secrets are obviously-fake, non-functional. Capabilities: `ruleset-ingestion`, `sanitization-scan`, `sanitization-apply`.

## 1. Package scaffold

- [x] 1.1 Create `packages/sanitizer/` (`@mosga/sanitizer`): `package.json` (ESM, `exports`/`main`/`module`/`types`), `tsconfig.json` extending `tsconfig.base.json`, `tsup.config.ts` (ESM + d.ts), `src/index.ts`. Depend on `@mosga/contracts` and `@mosga/session-readers` via the workspace (npm `*`).
- [x] 1.2 Add deps: `smol-toml` (gitleaks TOML parse), `zod` (report/rule schemas); confirm workspace install links `@mosga/*` locally and root `typecheck`/`build`/`test` still pass with the new package present.
- [x] 1.3 Add one smoke test so the package is picked up by the root vitest runner.

## 2. Contract schemas (report + rules)

- [x] 2.1 Define zod schemas + inferred types for the rule model: `NormalizedRule` (`id`, `description`, `regexSource`, `flags`, `keywords`, `entropy`, `secretGroup`, `allowlist`, `translation: { status: 'native'|'translated'|'degraded'|'disabled', notes }`) and `CustomRule` (`id`, `description?`, `kind: 'regex'|'literal'`, `pattern`, `replacement?`).
- [x] 2.2 Define zod schemas + types for `FindingLocation`, `Finding`, `NonTextItem`, `SanitizationReport`, and the `Layer`/`Disposition` enums per design D7. Export them for type-only downstream consumption (slices 3/4).
- [x] 2.3 Define the compiled-ruleset-artifact schema: `{ rulesetVersion, gitleaksVersion, generatedAt, rules: NormalizedRule[], degraded: Array<{ id, status, reason }> }`.

## 3. Ruleset ingestion

- [x] 3.1 Vendor the gitleaks `gitleaks.toml` at a pinned release tag into the package; record the tag as a constant. Do NOT fetch at build/runtime.
- [x] 3.2 Parse the vendored TOML with `smol-toml` into raw rule records (`id`, `description`, `regex`, `keywords`, `entropy`, `secretGroup`, per-rule `allowlist`) plus the global `[allowlist]`.
- [x] 3.3 Implement the RE2→JS translator + compatibility validator: named-capture `(?P<n>…)`→`(?<n>…)`, POSIX classes, `\A`/`\z`/`\Z`, leading inline flags hoisted; construct `RegExp` in try/catch; classify each rule `native|translated|degraded|disabled`.
- [x] 3.4 Implement the degradation ladder: on untranslatable regex, degrade to a case-insensitive keyword/literal matcher when keywords exist, else `disabled` with a reason. Guarantee conservation: `native+translated+degraded+disabled == total rules`.
- [x] 3.5 Implement custom-rules loading: literal entries regex-escaped, regex entries through the same validator; invalid entries reported (id + error) and skipped, not fatal; all classified Layer 2.
- [x] 3.6 Emit the compiled ruleset artifact with the composite `rulesetVersion` (`gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>`), the normalized rules, and the `degraded[]` manifest.
- [x] 3.7 Vitest: named-capture translates native; a back-reference/inline-flag-group degrades (does not throw); degraded rule appears in `degraded[]` with a reason; rule-count conservation holds; a literal custom rule matches metacharacters verbatim; an invalid custom regex is reported and skipped; the same artifact loaded twice yields an identical rule set; `rulesetVersion` changes when inputs change.

## 4. Scan engine

- [x] 4.1 Implement the structure-aware traversal yielding `(FindingLocation, resolvedString)` units for every scannable position: message `content`/`thinking`/command fields, `toolCalls[].input` (canonical serialized), `toolCalls[].result`, `toolResults[].content`, and session `cwd`/`title`.
- [x] 4.2 Implement L1 secret detection over each unit using the ingested rules: keyword pre-filter, regex match, entropy/`secretGroup` threshold, per-rule + global allowlist suppression; findings `layer:'secrets'`, `blocking:true`, redacted `matchPreview`.
- [x] 4.3 Implement L2 custom detection: findings `layer:'custom'`, `blocking:true`.
- [x] 4.4 Implement L3 normalization detectors (`path`, `username`, `email`, `ipv4`, `ipv6`) → findings `layer:'normalization'`, `blocking:false`, `category` set.
- [x] 4.5 Implement the session-scoped `PseudonymMapper`: `map(category, original)` first-encounter-sequential placeholders, session-scoped, not persisted across sessions; L3 findings carry the placeholder as `replacementSuggestion`.
- [x] 4.6 Implement stable `Finding.id` (hash of location + ruleId) so re-scan preserves dispositions.
- [x] 4.7 Implement non-text propagation: iterate EVERY message's `nonTextContent` (including markers on tool_use messages) → `NonTextItem[]`, disposition `pending`.
- [x] 4.8 Assemble the `SanitizationReport`: findings, `layerSummary` (secrets/custom pending; normalization `byCategory`), `nonTextItems`, and the pure `gate` computation (`unlocked = blockingPending==0 && nonTextPending==0`; L3 excluded).
- [x] 4.9 Add a ReDoS guard: per-field scan-time ceiling / large-field chunking; a timeout becomes a needs-review finding, never a silent skip.
- [x] 4.10 Vitest: secret only in a tool result is located at that tool call; tool-call input hit indexes into the canonical serialization; location+span round-trips to the exact substring; `Finding.id` stable across re-scan; L1/L2 blocking and L3 non-blocking; AWS docs example key suppressed; pseudonym consistent within a session and different across two sessions with different encounter order; secret `matchPreview` is redacted; gate locked while a blocking hit pending, unlocked when all blocking + non-text handled; image marker on a tool_use message yields a `NonTextItem` with content not stripped.

## 5. Apply engine

- [x] 5.1 Implement `applyDispositions(session, report, mapper)` returning a NEW session (no in-place mutation): per-finding `replace`/`delete`/`allow`.
- [x] 5.2 Implement offset-safe multi-hit application within a field (descending start-offset or rebuild); `toolCallInput` edits applied to the canonical serialization and re-parsed to the `input` object.
- [x] 5.3 Implement `batch-by-rule` and `batch-by-type` reusing the pseudonym mapping so identical originals collapse to the identical placeholder.
- [x] 5.4 Enforce the block-on-hit gate: refuse to emit a `meta.sanitized:true` session while `gate.unlocked` is false; allow a partial preview session.
- [x] 5.5 Emit the stamped export-ready session: `meta.sanitized:true`, `meta.sanitizationRulesetVersion` = report version, `session.cwd`/`title` normalized, `meta.contributorAlias` from the mapper, structure/`schemaVersion` unchanged (validate against `SanitizedSessionSchema`).
- [x] 5.6 Honor `NonTextItem` dispositions (`keep`/`remove`, default keep-and-confirm); never auto-strip non-text.
- [x] 5.7 Vitest: replace substitutes placeholder + input unchanged; allow leaves intact; two hits in one string both apply; tool-call input edit round-trips to an object; batch-by-type replaces all emails consistently; batch-by-rule replaces every hit of one rule; refuses to stamp while blocking pending, stamps when unlocked; output structurally isomorphic + `SanitizedSessionSchema`-valid; kept non-text survives; apply never auto-strips.

## 6. Canary + false-positive suite

- [x] 6.1 Build a hand-crafted fake session fixture embedding obviously-fake AWS/GitHub/generic secrets in `content`, `thinking`, `toolCalls[].input`, and `toolCalls[].result`; assert all caught as blocking findings at correct locations.
- [x] 6.2 Build a false-positive-guard fixture (AWS docs example key + benign secret-looking strings); assert no blocking finding is produced; assert every fixture secret is non-functional and no real session data is read.

## 7. Validation

- [x] 7.1 Run root `typecheck`, `build`, and `test` — all green.
- [x] 7.2 Run `openspec validate --change mosga-v01-sanitizer` (strict) and fix any errors until it passes.
