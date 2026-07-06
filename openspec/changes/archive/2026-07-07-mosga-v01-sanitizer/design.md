## Context

Slice 1 (readers) shipped `@mosga/contracts` and `@mosga/session-readers`: a raw session becomes a `SanitizedSession` envelope with `meta.sanitized:false`, `meta.sanitizationRulesetVersion:null`, and `messages: ParsedMessage[]` kept isomorphic to the source JSONL. This slice builds `@mosga/sanitizer`, the redaction core between "raw envelope" and "human-reviewed, export-safe envelope".

Real interfaces this slice binds to (read from the shipped code, not memory):
- `SanitizedSession = { schemaVersion, meta, session, messages }`; `meta = { contributorAlias, sourceCli, toolVersion, sanitizationRulesetVersion: string|null, exportedAt, license: string|null, sanitized: boolean }`; `session = { sessionId, sourceId, projectKey, cwd: string|null, title: string|null, updatedAt }`.
- `ParsedMessage` scannable string-bearing fields: `content`, `thinking`, `commandName`, `commandMessage`, `commandArgs`, `toolCalls[].input` (a `Record<string,unknown>`), `toolCalls[].result`, `toolResults[].content`.
- `NonTextContentMarker = { blockTypes: string[] }` on `ParsedMessage.nonTextContent`. Per the readers post-review fix (`parseClaudeSession.ts`), this marker can be resolved onto a **tool_use-carrying assistant message** (a screenshot returned inside a `tool_result` marks the `tool_use` message via `tool_use_id`), not only the obvious user message. The sanitizer MUST iterate every message's `nonTextContent`.

Constraints carried in (design doc + planning-context): Gitleaks rules are Go RE2 dialect and need translation + a compatibility validator; untranslatable rules must be explicitly listed and degraded, never silently dropped. Pseudonym mapping is session-consistent but cross-session inconsistent. Non-text is marked, not stripped. L1/L2 block-on-hit (未清零不解锁); L3 is statistics + sampling. Local pre-check and CI share one three-layer ruleset. Fixtures are hand-crafted fakes; canary secrets are obviously-fake.

## Goals / Non-Goals

**Goals:**

- Ingest the gitleaks ruleset (pinned, vendored, TOML-parsed, RE2→JS-translated, validated, degradation-manifested) and user custom rules into one normalized rule set, and emit a compiled artifact both the tool and slice-4 CI load.
- Scan `SanitizedSession` structure-aware across the three layers, producing a precise-location findings/report model plus a session-scoped deterministic pseudonym mapper.
- Apply dispositions (per-hit + batch) using the shared mapping and emit a stamped sanitized `SanitizedSession`.
- Guarantee (by test) that fake canary secrets are caught at every structural position and that named false positives are suppressed.

**Non-Goals:**

- No review UI, daemon, or gate-ENFORCEMENT UX (slice 3) — this slice provides the report + a pure gate-status function, not the "don't unlock export" interaction.
- No publishing, GitHub PR, or CI workflow files (slice 4) — but the compiled ruleset artifact format is designed to be CI-loadable.
- No export-schema dataset slicing (slice 4 export layer).
- No Presidio / LLM-based PII layer (design doc lists it optional; deferred).
- No network at runtime; the gitleaks config is vendored, not fetched.
- No changes to the shipped `@mosga/contracts` / `@mosga/session-readers` source (this slice only consumes them).

## Decisions

### D1 — Package boundary: schemas + engine both in `@mosga/sanitizer`

The report model, rule schemas, and engine all live in `@mosga/sanitizer`. Downstream slices consume the report/rule *types* via `import type` (erased at runtime, zero pull-in); slice 4's CI additionally imports the engine at runtime because it must actually re-run the scan. *Alternative considered:* hoist the report/rule schemas into `@mosga/contracts` (the readers D6 "shared data contract" home). Rejected for THIS slice because (a) `openspec/specs/` is empty — readers isn't archived — so there is no established `session-contracts` capability to file a MODIFIED delta against, and (b) the lead scoped everything under `@mosga/sanitizer`. Flagged in planner findings as a clean future refactor if the team wants report types in contracts.

### D2 — Ruleset ingestion: vendor + pin + compile, with a degradation manifest

The gitleaks config (`gitleaks.toml`) is vendored into the package at a **pinned release tag** (recorded in the manifest — e.g. `v8.18.x`), never fetched at runtime. Ingestion:
1. Parse TOML with `smol-toml` (small, ESM, zero-dep) → `[[rules]]` with `id`, `description`, `regex`, `keywords`, `entropy`, `secretGroup`, `allowlist`, plus the global `[allowlist]`.
2. Translate each rule `regex` (Go RE2) to a JS `RegExp` via the D3 translator.
3. Compile to a normalized rule object `{ id, description, regexSource, flags, keywords, entropy, secretGroup, allowlist, translation: { status, notes } }` where `status ∈ native | translated | degraded | disabled`.
4. Emit a **compiled ruleset artifact** (JSON) = `{ rulesetVersion, gitleaksVersion, generatedAt, rules[], degraded[] }`. `rulesetVersion` is a composite id (`gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>`) so a report/envelope records exactly which rules ran and slice-4 CI can assert version parity. The `degraded[]` list names every non-`native` rule and why — the design-doc "无声截断禁令" made machine-checkable.

*Alternative:* fetch gitleaks config at build/runtime — rejected (network dependency + supply-chain + non-reproducible). *Alternative:* hand-maintain a rule subset — rejected (drifts from upstream, loses coverage).

### D3 — RE2→JS translation behind a compatibility validator

Go RE2 and JS `RegExp` differ in syntax and features. The translator applies known-safe transforms, then constructs the `RegExp` in a `try/catch`; any construction failure or known-unsupported construct triggers **degradation, never a silent drop**:
- Named captures `(?P<n>…)` → `(?<n>…)`; back-references `(?P=n)` → unsupported → degrade.
- Leading inline flags `(?i)`, `(?s)`, `(?m)` → hoist to `RegExp` flags; mid-pattern inline-flag *groups* `(?i:…)` → not portable pre-ES2025 → degrade.
- POSIX classes `[[:alpha:]]` etc. → expand to explicit classes.
- Anchors `\A`→`^`, `\z`/`\Z`→`$`.
- Possessive quantifiers (`a++`) / atomic groups `(?>…)` → drop the possessive/atomic semantics to greedy and record a `translated` note (behavior-preserving for matching, not for catastrophic-backtracking guarantees — see Risks).
- Unicode property escapes `\p{…}` → keep with the `u` flag.

Degradation ladder when a faithful `RegExp` is impossible: (a) fall back to the rule's `keywords` as literal case-insensitive matchers (`degraded`, still catches the obvious cases, block-on-hit so a human sees them); (b) if there are no usable keywords, mark the rule `disabled` with a reason. Both land in the `degraded[]` manifest. RE2's linear-time guarantee is lost under JS's backtracking engine — mitigated in Risks (per-scan regex timeout / input chunking).

*Alternative:* run RE2 via a WASM build of Go's regexp — rejected for v0.1 (heavy dep, build complexity); revisit if degradation coverage proves insufficient.

### D4 — Gitleaks-faithful matching: keywords, entropy, secretGroup, allowlist

To keep the false-positive rate manageable (block-on-hit floods the reviewer otherwise) the scan mirrors gitleaks' own precision mechanics:
- **Keyword pre-filter**: a rule only runs against a field value that contains one of its `keywords` (fast-skip + fidelity).
- **secretGroup + entropy**: when a rule sets `entropy`, compute Shannon entropy of the `secretGroup` capture (or whole match if unset) and require ≥ threshold; sub-threshold matches are suppressed (matching gitleaks).
- **Allowlist**: honor per-rule and global `allowlist.regexes` and `allowlist.stopwords` (suppress a match whose secret is a known example/stopword — e.g. the AWS docs key `AKIAIOSFODNN7EXAMPLE`). `allowlist.paths` / `commits` are inapplicable to in-memory session scanning and are ignored **with a documented note** (not a silent omission).

### D5 — Structure-aware traversal with precise locations

The scanner walks `SanitizedSession` and yields a finding per hit with a structured `FindingLocation`, not a flat offset, so slice 3 can render the exact spot and slice 4/apply can re-resolve it:

```
FindingLocation {
  scope: 'message' | 'session'
  messageIndex?: number          // index into SanitizedSession.messages (scope=message)
  messageUuid?: string           // ParsedMessage.sdkUuid — stable across re-scans
  field: 'content' | 'thinking' | 'commandName' | 'commandMessage' | 'commandArgs'
       | 'toolCallInput' | 'toolCallResult' | 'toolResultContent'
       | 'sessionCwd' | 'sessionTitle'
  toolCallId?: string            // field = toolCallInput | toolCallResult
  toolResultIndex?: number       // field = toolResultContent
  span: { start: number; end: number }   // char offsets in the RESOLVED field string
}
```

Traversal targets (design-doc high-risk positions in bold): per message — `content`, `thinking`, command fields, `toolCalls[].input` (serialized deterministically for scanning), **`toolCalls[].result`** and **`toolResults[].content`** (command echoes / file dumps); per session — `cwd` and `title`. `toolCallInput` scanning serializes the `Record` to a canonical JSON string; a hit's span is into that serialized form (apply re-serializes identically). System-role message `content` covers the design doc's "系统提示" position.

### D6 — Session-scoped deterministic pseudonym mapping

A `PseudonymMapper` is created fresh per `SanitizedSession`. `map(category, original) → placeholder` assigns a stable placeholder on first encounter (`<PATH_1>`, `<EMAIL_1>`, `<IPV4_1>`, `<USER_1>`, …) and returns the same placeholder for the same `original` for the rest of that session. Assignment is **first-encounter-order sequential within the session**, which makes it cross-session inconsistent by construction: the same path may be `<PATH_1>` in one session and `<PATH_4>` in another, so a placeholder cannot be used to link a contributor across sessions (design-doc intent). The mapping table is session-scoped and never persisted across sessions. L3 findings carry the mapper's placeholder as `replacementSuggestion`; batch replace reuses the mapper so identical originals collapse to identical placeholders. The primary contributor username's placeholder also fills `meta.contributorAlias`.

### D7 — Findings / report model (load-bearing for slices 3–4)

```
Layer = 'secrets' | 'custom' | 'normalization'          // L1 | L2 | L3
Disposition = 'pending' | 'replace' | 'delete' | 'allow'  // default 'pending'

Finding {
  id: string                    // stable hash of (location + ruleId) — disposition key across re-scans
  layer: Layer
  ruleId: string                // gitleaks rule id | custom rule id | L3 category id
  category?: string             // L3: 'path' | 'username' | 'email' | 'ipv4' | 'ipv6'
  location: FindingLocation
  matchPreview: string          // SAFE-to-display preview; secrets are redacted (never the raw secret)
  replacementSuggestion: string // placeholder / pseudonym
  disposition: Disposition
  blocking: boolean             // true for secrets + custom (block-on-hit); false for normalization
}

NonTextItem {
  messageIndex: number
  messageUuid: string
  blockTypes: string[]          // from ParsedMessage.nonTextContent (may sit on a tool_use message)
  disposition: 'pending' | 'keep' | 'remove'
}

SanitizationReport {
  reportVersion: string
  sanitizationRulesetVersion: string   // == compiled ruleset composite version
  sessionId: string
  generatedAt: string                  // ISO-8601
  findings: Finding[]
  layerSummary: {
    secrets: { total: number; pending: number }
    custom: { total: number; pending: number }
    normalization: { total: number; byCategory: Record<string, number> }
  }
  nonTextItems: NonTextItem[]
  gate: { blockingTotal: number; blockingPending: number; nonTextPending: number; unlocked: boolean }
}
```

`matchPreview` for secrets/custom is redacted (e.g. first/last 2 chars + length) — the report is persisted and must never itself become a leak. `gate.unlocked = blockingPending === 0 && nonTextPending === 0` (design-doc "命中项已全部处置 + 含图记录已逐条确认"); L3 does not gate. `Finding.id` is a stable hash so a re-scan preserves the user's dispositions (slice 3 UX).

### D8 — Apply / disposition engine

`applyDispositions(session, report, mapper) → SanitizedSession`:
- Per finding: `replace` → substitute span with `replacementSuggestion`; `delete` → remove the span; `allow` → leave as-is; `pending` → treated as unresolved (the engine refuses to emit an export-ready session while any `blocking` finding is `pending`, surfacing via `gate.unlocked=false`).
- **Batch**: `batch-by-rule` / `batch-by-type` set one disposition across all findings sharing a `ruleId`/`category`; because the pseudonym mapping is deterministic, batch replace maps identical originals to identical placeholders (design doc).
- **Offset safety**: within each resolved field string, apply edits in descending `span.start` order (or rebuild the string) so earlier spans' offsets stay valid; `toolCallInput` edits are applied to the canonical serialized form and re-parsed back into the `Record`.
- Output: a new `SanitizedSession` with edited `messages`, `session.cwd`/`title` normalized, `meta.contributorAlias` set from the mapper, `meta.sanitized = true`, and `meta.sanitizationRulesetVersion = <compiled ruleset version>`. Non-text is never stripped by apply — `NonTextItem` dispositions (`keep`/`remove`) are honored (remove drops that message's non-text presence per user choice) but the default is keep-and-confirm.

## Risks / Trade-offs

- **A translated/degraded rule silently misses a real secret** → the `degraded[]` manifest names every non-native rule; degraded rules keep a keyword literal matcher (block-on-hit) so obvious cases still surface; canary tests assert catches at every structural position. Residual gap is explicit and reviewable, not hidden.
- **JS backtracking on a hostile/huge field → ReDoS / hang** (RE2's linear guarantee is lost, D3) → cap per-field scan time and/or chunk very large field values with a documented ceiling; treat a timeout as a "possible-hit, needs review" finding rather than a skip (fail safe toward recall).
- **Storing raw secrets in the report re-leaks them** → `matchPreview` is redacted for secrets/custom; the raw match lives only in the in-memory apply pass, never in the persisted report.
- **Pseudonym reversibility / cross-session linking** → first-encounter-sequential, session-scoped, never persisted across sessions (D6); no salt derived from the original value that would reproduce across sessions.
- **Entropy/allowlist tuning floods or starves the reviewer** → mirror gitleaks' own keyword+entropy+allowlist mechanics (D4) for a known baseline; FP-guard tests pin named suppressions; block-on-hit means over-reporting is safe-but-annoying, under-reporting is catastrophic, so defaults bias to recall.
- **Ruleset version drift between tool and CI** → single composite `rulesetVersion` stamped into the compiled artifact + the report + the sanitized envelope; slice-4 CI asserts version parity before trusting a pre-checked PR.
- **Non-text marker on a tool_use message is missed** → traversal iterates ALL messages' `nonTextContent` (not just user messages); a fixture with a `tool_result`-nested image asserts the `NonTextItem` is produced.

## Migration Plan

Additive; no migration. Sequencing within the slice: (1) ruleset ingestion (vendor TOML → parse → translate/validate → compiled artifact + degradation manifest) with translator unit tests; (2) scan engine (traversal + 3-layer detection + pseudonym mapper + report model) with canary/FP tests; (3) apply engine (dispositions + batch + stamped envelope) with round-trip tests; (4) `openspec validate`. Rollback = delete the package; no external state touched. No publish in this slice.

## Open Questions

- **Exact pinned gitleaks tag** and how many of its ~150 rules translate `native` vs `degraded` — measured during ingestion; the `degraded[]` count is a quality signal, not a blocker.
- **ReDoS ceiling values** (per-field timeout / max field length before chunking) — pick conservative defaults, revisit with real session sizes.
- **Whether `toolCallInput` canonical serialization** should be sort-keyed JSON vs. source-order — leaning sort-keyed for deterministic spans; confirm nothing downstream needs source key order.
- **contributorAlias when no username is detectable** (e.g. a session with no home-path/username signal) — fall back to a fixed neutral alias; final value coordinated with slice-4 export.
- **L3 sampling policy** (design doc "抽检") is a slice-3 UI concern; slice 2 provides full L3 findings + `byCategory` stats and leaves sampling selection to the UI.
