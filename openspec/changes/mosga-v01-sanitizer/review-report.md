# Review Report — mosga-v01-sanitizer

**Reviewer:** reviewer-sanitizer (adversarial security review; did not author the code)
**Date:** 2026-07-07
**Scope:** `packages/sanitizer/**` + root wiring (`package.json`, `tsconfig.base.json`, `vitest.config.ts`) against `proposal.md`, `design.md`, `specs/`, `tasks.md`, and the fixed cross-slice contracts in `openspec/changes/mosga-v01/planning-context.md` ("Planner findings — sanitizer").

## Verdict: **NEEDS-FIX** (1 Blocker, 3 Major, 4 Minor)

The detection core is fundamentally sound — all 16 sampled gitleaks rules (native + translated + inline-flag-group + named-capture) catch their fake positives, rule-count conservation holds exactly (30+143+0+0=173), the allowlist suppresses the AWS docs key, pseudonym mapping is session-consistent/cross-session-inconsistent, gate integrity holds, and matchPreview is redacted. **However, one L3 detector (`EMAIL_RE`) is a catastrophic-backtracking ReDoS that hangs the scanner for ~1 minute on ordinary large tool-outputs, and the pre-registered 250ms-per-field ceiling does not actually protect against it.** That is a Blocker for a tool whose whole job is to reliably process every field.

---

## Commands run (real results)

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (contracts, session-readers, sanitizer all clean) |
| `npm run build` | PASS (tsup ESM 31.64 KB + d.ts) |
| `npx vitest run` | PASS — 11 files, **64/64 tests** |
| `grep -c '^\[\[rules\]\]' vendor/gitleaks.toml` | **173** rules |
| `compileRuleset()` translation counts | native=30, translated=143, degraded=0, disabled=0, **sum=173** ✓ conserved; `degraded[].length=0` |
| Fake-positive probe, 16 rules | **16/16 caught** as blocking (aws-access-token, github-pat, github-fine-grained-pat, gitlab-pat, slack-bot-token, stripe-access-token, private-key, jwt, jwt-base64, gcp-api-key, npm-access-token, openai-api-key, sendgrid-api-token, digitalocean-pat, telegram-bot-api-token, square-access-token) |
| ReDoS probe, 200k field | scan took **57.7 s**; culprit = `EMAIL_RE` (~59 s alone) |
| EMAIL_RE scaling | 20k→0.36s, 40k→1.4s, 80k→8.3s (O(n²)); realistic 120k base64 blob → **21 s** |
| Other L3 regexes (path/username/ipv4/ipv6) at 120k | all <3 ms (linear, fine) |

`vendor/gitleaks.toml` header pins `v8.18.4`, matching `GITLEAKS_VERSION` in `src/gitleaks.ts`. Fixtures verified obviously-fake (`AKIAFAKEFAKEFAKE1234`, `ghp_` + 36×a, etc.); the FP-guard fixture uses the real AWS docs example key which is a documented non-secret.

---

## Round 1 re-review (delta only)

**Re-review date:** 2026-07-07 · **Delta files:** `detectors.ts`, `scan.ts`, `apply.ts`, `schemas.ts`, `index.ts`, new `__tests__/review-fixes.test.ts`.

**Gates:** `npm run typecheck` clean · `npm run build` success · `npx vitest run` **68/68** (was 64; +4 review-fix tests).

### Per-finding status

| ID | Prior severity | Status | Evidence |
|---|---|---|---|
| **B1** EMAIL_RE ReDoS | Blocker | **RESOLVED** | Bounded regex `{1,64}@{1,255}...{2,24}`. The exact 199k field that took ~57s now scans in **100ms**. 7 adversarial shapes (dense `@`, no-dot near-miss, valid-ish with 28k matches, tld-too-short) all ≤117ms. L3 loop now carries the same 250ms between-detector budget (`scan.ts:387`) → `timedOut` fires the blocking `redos-guard`. |
| **M1** overlap drops outer path edit | Major | **RESOLVED** | `editString` rewritten (`apply.ts:142-158`): sort start-asc/end-desc, greedy non-overlap keeps the OUTER span. `/home/alice/secretproj/app.ts` + both categories replaced → `<PATH_1>` (no `secretproj`/`alice` leak); Windows `C:\Users\bob\Projects\secret.txt` → `<PATH_1>` (no `bob`/`Projects`); 3-nested + same-start synthetic → outer wins. |
| **M2** unguarded JSON.parse aborts apply | Major | **RESOLVED** | `jsonStringEscape` (`apply.ts:99`) escapes toolCallInput replacements; re-parse wrapped in try/catch (`apply.ts:298`, leaves field unedited on failure). 8 hostile replacements (quotes, `","injected":"pwned`, lone `\`, 5× quote, newline/tab, braces, unicode-escape, `\\"\`) all apply without throwing, produce valid objects, no leak. **JSON-injection attempt is neutralized** — `","injected":"pwned` lands as a string value, no new key created. |
| **M3** silent rule-drop on consumer | Major | **RESOLVED** | `compileMatchers` (`scan.ts:126`) degrades a compile-failed rule to its keyword matcher (still runs, verified) or, keywordless, emits a **blocking, gating** `ruleset-compile-error` finding + `rulesetWarnings[]`. Gate stays locked (blockingPending=2). New `rulesetMeta` field enum validates against `SanitizationReportSchema` and `FindingSchema`; apply ignores it (readField→undefined) with no crash, stamps once disposed. |
| **m2** allowlist regexTarget:'match' | Minor | **RESOLVED** | `scan.ts:174-175` now tests the full match for `regexTarget:'match'`. |
| **m4** entropy `<` vs `<=` | Minor | **RESOLVED** | `scan.ts:239` now `<= threshold` (require strictly greater), matching gitleaks. |

### Accepted-known items — reviewer position

- **m1 (group-1 entropy/span target instead of gitleaks whole-match): CONCUR — keep as-is.** The implementer's empirical claim checks out and my round-1 suggestion was wrong. generic-api-key's `[rules.allowlist].stopwords` (1474 entries) contains `token`, `client`, `password`, `word`, `auth`, `acces` — all substrings of the keyword prefixes that begin *every* whole-match. Using the whole match as the "secret" for the stopword check would therefore falsely suppress real keys written as `password = "<key>"`, `access_token = "<key>"`, `client_secret: "<key>"`. Confirmed: the current group-1 code flags all three (span = the value only), which whole-match would have dropped as false negatives. Group-1 is the recall-safe and more faithful choice; the code comment documents it. **My round-1 m1 is withdrawn.**
- **m3 (compiled ruleset stays a pure function; serialized artifact deferred to slice 4): CONCUR.** Determinism was verified in round 1 (repeated compiles identical; `rulesetVersion` a stable composite). Slice 4 owns the CI wiring and can serialize the format it needs. Non-defect. Standing caveat (for slice 4's contract, not this slice): slice-4 CI must pin the exact `@mosga/sanitizer` version so both sides run the identical `compileRuleset()`.

### New findings (introduced-or-surfaced by the delta)

- **R1 (Minor, residual, non-blocking):** `editString` handles *nested* overlap correctly (outer wins) but for *partial, non-containment* overlap it keeps the earlier-start edit and drops the later one, leaving the dropped edit's non-overlapping tail in place (`[0,6]+[4,10]` → `<A>GHIJ`). For two L3 findings this is cosmetic; for two L1 secret rules matching overlapping-but-not-nested spans of the same region, the dropped rule's tail would remain unredacted. This is an edge case (uncommon for real rules) and is **not a regression** — round-1 code had the same class of behavior (it dropped the outer instead). Suggested hardening: merge overlapping edit spans into their union rather than dropping one. Flagging for awareness, not gating.

### Re-review verdict: **CLEAN**

All 1 Blocker + 3 Major + 2 Minor from round 1 are resolved and independently verified; both accepted-known items are concurred (m1 with my round-1 finding formally withdrawn). One non-blocking Minor residual (R1) noted for future hardening. No new blocking or major issues.

---

## Findings

### BLOCKER

#### B1 — `EMAIL_RE` catastrophic backtracking (ReDoS); 250ms ceiling not enforced for L3
**File:** `packages/sanitizer/src/detectors.ts:34` (regex) + `packages/sanitizer/src/scan.ts:293-310` (L3 loop) + `scan.ts:26` (budget const)

The L3 email detector `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g` backtracks quadratically on any long run of word-characters that lacks an `@`. Measured: **~59 s** on a 200,000-char field, and **21 s** on a realistic 120k base64 blob. Scaling is clean O(n²) (20k→0.36s, 40k→1.4s, 80k→8.3s).

This is not a hostile-input-only problem: Claude Code sessions routinely put large tool outputs (base64 image data, minified JS, log dumps, big JSON) into `toolCalls[].result` / `toolResults[].content`, all of which are long runs of `[A-Za-z0-9._+-]` without `@`. A single such field freezes the sanitizer for tens of seconds; a session with several freezes it for minutes.

Two compounding root causes:
1. **L3 has no time-budget check at all** — the `FIELD_TIME_BUDGET_MS = 250` guard exists only in the L1 (`scan.ts:250`) and L2 (`scan.ts:272`) loops. The L3 detector loop (`scan.ts:293-310`) runs with zero interruption.
2. **The 250ms ceiling can never interrupt a single `matchAll`** anyway (JS regex execution is synchronous and non-interruptible), so even the L1/L2 check only fires *after* an already-slow matcher returns. The 200k truncation cap (`MAX_SCAN_CHARS`) does not help because 200k chars is already enough for a ~59s hang.

This directly violates pre-registered Blocker condition #6 ("250ms ceiling + 200k cap actually enforced per field").

**Suggested fix:** Make the regex linear by bounding the quantifiers to realistic lengths, e.g. `/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g` (RFC-shaped bounds), which removes the unbounded backtracking. Additionally wrap the L3 detector loop in the same between-detector time-budget check used by L1/L2, and emit the `redos-guard` blocking finding if L3 is cut short (so a truncated L3 pass still fails safe toward review rather than silently under-normalizing). Add a regression test asserting a 200k tokenless field scans in well under the budget.

---

### MAJOR

#### M1 — Overlapping path + username replace silently drops the outer (path) edit → directory/project names leak
**File:** `packages/sanitizer/src/apply.ts:111-133` (`editString`, overlap guard at :128)

The username finding is a sub-span of the path finding (username detector matches inside the home path). When a reviewer sets **both** `path` and `username` to `replace` (a first-class batch operation — `batchByType`), `editString` sorts edits by descending start and skips any edit whose `end` overlaps an already-applied one. The inner username (later start) is applied first, so the outer path edit is skipped.

Reproduced: `opened /home/alice/secretproj/app.ts here` with both categories replaced →
`opened /home/<USER_1>/secretproj/app.ts here` — the proprietary directory name `secretproj` and file path **leak through**, even though the user explicitly chose to redact the path. This is exactly the "company code identifiers / local paths" the proposal exists to remove. Ships silently because L3 is non-blocking. The code comment at :128 is also wrong — it claims "outer/later-start edit wins" but the later-start edit is the *inner* one.

(Replacing `path` alone works correctly — the whole path collapses to `<PATH_1>`; the bug is specific to overlapping replace of both.)

**Suggested fix:** When two edits overlap, prefer the **outer/wider** span (the one that fully contains the other) and drop the nested one — a path replacement subsumes its username. Sort by start ascending and by width descending, or detect containment explicitly. Fix the comment to match.

#### M2 — Unguarded `JSON.parse` in toolCallInput apply aborts the entire sanitization
**File:** `packages/sanitizer/src/apply.ts:260`

`writeField` for a `toolCallInput` edit does `call.input = JSON.parse(value)` with no error handling. If an edit makes the canonical JSON invalid, the thrown `SyntaxError` propagates out of `applyDispositions` and aborts the whole apply pass, discarding all sanitization work.

Reproduced: a custom rule with `replacement: '"broken}'` (JSON-special characters) applied to a `toolCallInput` field →
`SyntaxError: Expected ',' or '}' after property value in JSON`, uncaught. `CustomRule.replacement` is a first-class user-supplied feature (`schemas.ts:73`), so this is reachable through normal configuration, not just adversarial input. A `delete` disposition whose span crosses a JSON structural boundary can trigger the same.

**Suggested fix:** Wrap the re-parse in try/catch; on failure, leave that tool call's `input` unedited and surface a needs-review/blocking finding (fail safe) rather than throwing. Consider validating that a `toolCallInput` replacement/deletion keeps the JSON well-formed before committing it (or escape replacement text as a JSON string value).

#### M3 — `compileMatchers` silently swallows RegExp construction errors, breaking the "never silently drop a rule" guarantee across the tool/CI boundary
**File:** `packages/sanitizer/src/scan.ts:103-113` (empty `catch` at :108)

The compiled ruleset artifact is explicitly designed to be loaded by BOTH the tool and slice-4 CI (design D2, spec "Compiled shared-ruleset artifact for tool and CI"). A `regexSource` that compiles on the authoring runtime but not on the consumer's — e.g. `(?i:...)` inline-flag groups (used by `telegram-bot-api-token`), which require a recent V8/Node — will throw in `compileMatchers` on the consumer, and the empty catch drops the rule with **no finding and no warning**. This contradicts the project's core "无声截断禁令 / no silent truncation" principle at exactly the cross-environment boundary the artifact exists to serve. In this review environment (Node 24) everything compiles, so it is latent, but it is a real hole for CI on a different runtime.

**Suggested fix:** On a scan-time compile failure, record the rule id into a surfaced list (or degrade it to its keyword matcher on the spot) instead of swallowing — never let a rule vanish silently. At minimum, log/collect the failed rule ids so a parity check can detect divergence.

---

### MINOR

#### m1 — Entropy computed on capture-group-1 default deviates from gitleaks (whole-match)
**File:** `packages/sanitizer/src/scan.ts:163`

`const group = rule.secretGroup ?? (m[1] !== undefined ? 1 : 0)` auto-uses capture group 1 when no `secretGroup` is set; gitleaks uses the whole match for the secret (and its entropy) unless `secretGroup` is configured. Effect is recall-biased (group 1 typically higher per-char entropy → passes the threshold more often → more findings), and the tighter span is actually better for redaction, so this is safe — but it is a documented fidelity deviation from gitleaks entropy semantics. Consider matching gitleaks (whole match unless `secretGroup`) or noting the intentional deviation.

#### m2 — Allowlist `regexTarget:'match'` tested against secretGroup, not the full match
**File:** `packages/sanitizer/src/scan.ts:123`

`const target = al.regexTarget === 'line' ? line : secret` uses the (possibly narrower) secretGroup value for `regexTarget:'match'`, whereas gitleaks tests the full regex match. Recall-biased (may under-suppress → more findings, which is safe), but a fidelity gap; the design's "documented note" for allowlist semantics doesn't cover this. Low impact.

#### m3 — No serialized compiled-artifact file is emitted; tool/CI parity relies on identical package version
**File:** `packages/sanitizer/src/ingest.ts:260` (`compileRuleset` returns an object; nothing written to disk)

Tasks 3.6 / the spec speak of "emit a compiled ruleset artifact (JSON)"; the implementation realizes this as a deterministic pure function rather than a written file. This is acceptable given determinism (both sides calling `compileRuleset()` on the same vendored TOML get identical rules — verified), but slice-4 CI parity then depends on pinning the exact `@mosga/sanitizer` version. Worth an explicit note in the artifact/versioning contract, or emit a checked-in JSON for CI to diff against.

#### m4 — Entropy threshold comparison is `<` (require ≥) vs gitleaks `<=` (require >)
**File:** `packages/sanitizer/src/scan.ts:173`

`shannonEntropy(secretValue) < rule.entropy` suppresses only strictly-below-threshold matches; gitleaks skips `entropy <= threshold`. Off-by-epsilon at the exact threshold value; recall-biased and negligible.

---

## Confirmed correct (adversarially checked)

- **Detection soundness (Blocker cond. #1):** 16/16 sampled rules across native / `(?i)`-hoisted-translated / inline-flag-group (`telegram`) / named-capture (`jwt-base64`) categories catch their fake positives through the compiled ruleset.
- **Rule-count conservation (cond. #2):** 30+143+0+0 = 173 = TOML rule count, exactly. Degradation ladder's degraded/disabled paths are exercised by the synthetic-TOML test (`backref-rule`→degraded, `no-keyword-untranslatable`→disabled); the real vendored set degrades nothing.
- **Structure-aware coverage (cond. #3):** `collectScanUnits` (`scan.ts:45-86`) traverses every field the planner listed — content, thinking, commandName/Message/Args, toolCallInput (canonical-serialized), toolCallResult, toolResultContent, sessionCwd, sessionTitle. `collectNonTextItems` (`scan.ts:371-384`) iterates **every** message's `nonTextContent`, including markers on tool_use messages (verified by test). No missed field.
- **Gate integrity (cond. #4):** `applyDispositions` recomputes the gate from live dispositions (`apply.ts:153`), not from a possibly-stale `report.gate`; the `redos-guard` finding is `blocking:true` and gates; non-text pending gates. The only way "past" the gate is an explicit human `allow`/`keep` disposition, which is the intended semantics (human takes responsibility), not a bypass.
- **Pseudonym mapping (cond. #5):** session-consistent, cross-session-inconsistent by first-encounter counter (verified by test + `pseudonym.ts`); no salt derived from the value; batch replace reuses baked suggestions so identical originals collapse identically. (Overlap handling defect is M1, above.)
- **ReDoS guard fail-safe (cond. #6, partial):** an oversize/timed-out field DOES emit a `blocking` `redos-guard` finding that keeps the gate locked — the fail-safe direction is right; the defect (B1) is that the ceiling doesn't actually bound L3 execution time.
- **Allowlist augmentation (cond. #7):** `MOSGA_ALLOWLIST_STOPWORDS` (`gitleaks.ts:24`) is documented, versioned into the composite `rulesetVersion` via `MOSGA_L3_VERSION`, contains only the 2 AWS docs example keys, and (substring stopword match) cannot suppress anything beyond strings literally containing those examples.
- **Entropy/keyword fidelity (cond. #8):** keyword pre-filter mirrors gitleaks granularity; entropy gate suppresses low-entropy `generic-api-key` and passes high-entropy (verified). Minor deviations m1/m4 above.
- **Canaries/fixtures (cond. #9):** all fixture secrets are obviously-fake; the only real-looking value is the documented AWS docs example key used deliberately as an FP guard. No real session data read.
