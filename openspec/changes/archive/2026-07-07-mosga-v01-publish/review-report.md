# Review Report — mosga-v01-publish

**Reviewer:** reviewer-publish (adversarial; did not author the code)
**Date:** 2026-07-07
**Scope:** `packages/publisher/**`, `templates/community-data-repo/**`, `INCIDENT-RESPONSE.md`, root `package.json` diff — against the change's `proposal.md` / `design.md` / `specs/` / `tasks.md` and the fixed contracts in `openspec/changes/mosga-v01/planning-context.md`.

## Verdict: **NEEDS-FIX**

The pre-check — the project's stated "last independent line of defense" — scans a **strict subset** of the bytes it publishes. A blocking secret planted in any field outside that subset (`meta.*`, `schemaVersion`, `session.{sessionId,sourceId,projectKey,updatedAt}`) survives into the committed JSONL **and** passes CI, because CI re-runs the identical function. This is a pre-registered Blocker condition ("ANY publishable-with-surviving-secret path is a Blocker"), and I proved it with a runnable PoC. The change must not ship until the pre-check scans the actual published bytes.

### Finding counts
- **Blocker: 1**
- **Major: 2**
- **Minor: 1**
- Trivial: 0

---

## Commands run (real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (all 6 packages, `tsc --noEmit` clean) |
| `npm run build` | PASS (all packages, tsup ESM + DTS, exit 0) |
| `npx vitest run` | **125 passed (29 files)** — matches the expected 125 |
| Reviewer PoC (temp test, since removed) | 4/4 asserted — see Blocker 1 |

Fixtures are fake-only (verified: `FAKE_GITHUB_PAT`, `FAKE_AWS_KEY`, all canary fixtures carry `CANARY` + obviously non-functional values). No test performs a live upload or opens a live external PR (verified in `pr.test.ts`: `FakeRunner` records commands and never execs git/gh; the one real-git test uses a throwaway `git init` tempdir; `submitContribution`/push is never called).

---

## BLOCKER

### B1 — Pre-check scans a strict subset of the published bytes; a secret in any unscanned field survives into the artifact AND passes CI

**Files:** `packages/publisher/src/precheck.ts:90-109` (`precheckRecord` → `scanSession`), `packages/sanitizer/src/scan.ts:45-86` (`collectScanUnits`), `packages/publisher/src/export.ts:109` (`JSON.stringify(valid)`).

**What the spec promises.** `specs/publish-precheck/spec.md`: *"re-run the `@mosga/sanitizer` scan on the exact artifact about to be published"* and design D2: *"it verifies the final bytes, so a real secret the human mistakenly `allow`ed, or one in a field the gate under-covered, is still caught."* The pre-registered attack surface names this exactly: *"a field the exporter includes but the scanner's structure-aware traversal doesn't reach … a secret in the provenance/meta block itself."*

**What the code does.** `exportSession` serializes the **entire** envelope: `const jsonl = JSON.stringify(valid)` — every field of `SanitizedSession` (schemaVersion, meta, session, messages). The pre-check calls `scanSession`, whose `collectScanUnits` traverses **only**:
- `session.cwd`, `session.title`
- per message: `content`, `thinking`, `commandName`, `commandMessage`, `commandArgs`, `toolCalls[].input`, `toolCalls[].result`, `toolResults[].content`

It never visits `schemaVersion`, `meta.*` (`contributorAlias`, `sourceCli`, `toolVersion`, `sanitizationRulesetVersion`, `exportedAt`, `license`), or `session.{sessionId, sourceId, projectKey, updatedAt}`. `applyDispositions` (`packages/sanitizer/src/apply.ts:232-319`) likewise only ever reads/writes those same fields, so these fields are unscanned and un-normalized at **every** layer — the pre-check has *identical* field coverage to the human gate and therefore catches nothing the gate under-covered, directly contradicting D2's rationale.

Because the community CI re-scan (`templates/community-data-repo/scripts/scan-changed.mjs:36`) calls the **same** `precheckRecord`, a PR carrying a secret in an unscanned field also passes CI (attack-surface condition 5: "a path where a PR with a secret passes CI").

**Proof (runnable PoC).** I added a temporary test (`packages/publisher/src/__tests__/_poc_reviewer.test.ts`, since removed to leave the tree clean) and ran it with vitest:

```
projectKey case → precheck ok = true  blocking = 0   (bytes contain AKIAFAKEFAKEFAKE1234)
meta.toolVersion case → precheck ok = true            (bytes contain ghp_…)
meta.contributorAlias case → precheck ok = true        (bytes contain ghp_…)
control (content) case → precheck ok = false           (same secret in message content IS caught)
```

Each case asserted `record.jsonl` contains the fake secret and `precheckRecord(record.jsonl).ok === true` (i.e. the exporter would write it and no PR guard trips). The control proves the ruleset detects the identical token — the only difference is field placement.

**Fix.** Make the pre-check scan the bytes it actually publishes, not a reconstructed subset. Options, in order of robustness:
1. Add the currently-unscanned string fields (`meta.contributorAlias`, `meta.toolVersion`, `meta.license`, `session.sessionId`, `session.sourceId`, `session.projectKey`, `schemaVersion`) as scan units so any L1/L2 hit there is blocking; and/or
2. Run the compiled ruleset a second, structure-agnostic pass over the raw serialized JSONL string as a belt-and-suspenders backstop (any blocking hit anywhere in the bytes refuses). This is the only approach that closes the whole class rather than an enumerated list.

Either way, add a regression test that plants a blocking secret in `projectKey` and in a `meta` field and asserts refusal.

---

## MAJOR

### M1 — `session.projectKey` leaks the contributor's real OS username, defeating pseudonymization

**Files:** `packages/daemon/src/envelope.ts:35` (`projectKey: ref.projectKey`), `packages/session-readers/src/claudeProjectsPaths.ts:22-24` (`encodeProjectPath`), `packages/session-readers/src/adapter/claudeCodeAdapter.ts:132`.

`projectKey` is `encodeProjectPath(cwd)` — the raw working-directory path with every non-alphanumeric replaced by `-`, e.g. `/Users/alice/code/proj` → `-Users-alice-code-proj`. It is copied verbatim into the published record and is **never scanned or normalized**. Meanwhile the equivalent `session.cwd` *is* scanned and gets normalized to `<PATH_1>`/`<USERNAME_1>` (the username detector + path detector), and that same primary username becomes `meta.contributorAlias`. So after a fully diligent review that pseudonymizes the username everywhere it is shown, the raw username still ships inside `projectKey`. This defeats the project's core privacy invariant (planning-context: "会话内确定性贡献者化名 … 跨会话不一致").

This is a specific, always-reachable instance of B1 (a leak in an unscanned field on the happy path) but is a distinct leak *class* — PII/deanonymization rather than an L1 API-key — so it is called out separately: even after B1 is fixed by "make secrets in these fields blocking," a username in a path is an L3 (non-blocking) category and would still ship unless `projectKey` is normalized.

**Fix.** Derive `projectKey` at export from the already-normalized `cwd` (re-encode the pseudonymized path), or run the L3 path/username normalizer over `projectKey` and apply the same pseudonym mapper so it becomes `-PATH_1-` / matches the cwd placeholder.

### M2 — CI version-parity is pinned but never verified; a mismatch is silent, contradicting the stated guarantee

**Files:** `packages/publisher/src/pr.ts:282-285` (PR-body claim), `templates/community-data-repo/scripts/scan-changed.mjs:36-40`, `specs/publish-precheck/spec.md` ("Pre-check parity with CI is version-pinned").

The spec requires: *"A rules or engine version the CI cannot match SHALL be a visible failure, never a silent divergence,"* and the generated PR body tells maintainers *"a `rulesetVersion`/`sanitizerPackageVersion` mismatch is a visible failure, not a silent divergence."* Nothing enforces this. The exporter writes a `*.provenance.json` sidecar with `sanitizerPackageVersion`/`rulesetVersion`, but `scan-changed.mjs` never reads that sidecar and never compares it to the installed engine — it only prints its own engine version. If a contributor's local `@mosga/sanitizer` differs from the community repo's pin, CI re-scans with the repo's version and passes with no signal that the verdicts came from different engines. The maintainer-facing claim is therefore false as implemented.

(Safety impact is bounded because CI re-scans authoritatively with its own pinned engine — it is not a direct leak path — but the m3 "visible failure on mismatch" requirement is unmet, which is the whole point of recording `sanitizerPackageVersion`.)

**Fix.** In `scan-changed.mjs`, load the record's paired `*.provenance.json` and fail the job when `provenance.sanitizerPackageVersion !== result.engine.sanitizerPackageVersion` (or `rulesetVersion` differs), emitting the mismatch. Add a template test asserting a doctored sidecar version fails the scan.

---

## MINOR

### m1 — Provenance sidecar is committed but outside the scan boundary

**Files:** `packages/publisher/src/pr.ts:165` (writes `*.provenance.json`), `scan-changed.mjs:19` (scans only `*.jsonl`).

The committed provenance sidecar is never scanned by the pre-check or CI. Today it holds only machine-generated version strings, so the leak risk is low, but it is published bytes outside the verification boundary — the same class of gap as B1. Worth either scanning it or documenting explicitly that it is version-strings-only and asserting its shape (it already validates via `ProvenanceStampSchema` on the write side, but CI does not re-check it). Fixing M2 (reading the sidecar in CI) naturally brings it inside the boundary.

---

## What is correct (verified, not assumed)

- **Refusal completeness (condition 2):** `assertPrecheckClean` (`precheck.ts:117-126`) throws `PublishRefusedError` on any `f.blocking` finding — covers `secrets`, `custom`, `redos-guard`, and `ruleset-compile-error` (all carry `blocking:true` in `scan.ts`). `planContribution` (`pr.ts:89`) calls it **before** computing any staged output, so a refusal returns nothing to stage; `pr.test.ts:65-73` confirms a failed pre-check leaves the target dir empty (`readdirSync(repo)` length 0). CLI (`cli.ts`) sets `process.exitCode = 1` on refusal in both the `precheck` command and the catch block. *Within the scanned fields*, refusal is airtight — the defect is field coverage (B1), not refusal wiring.
- **Provenance reads the resolved package version (condition 3):** `version.ts:25-51` resolves `@mosga/sanitizer`'s real `package.json` version (not a hardcoded string); the template pins exact versions (`template.test.ts:35-39` enforces `^\d+\.\d+\.\d+$`). The gap is verification, not the stamp source (M2).
- **PR/git safety (condition 4):** No test can open a live PR or push to a real remote; `submitContribution`'s push/`gh pr create` path is never invoked by tests; `.mosga-pr-body.md` is gitignored so the working file is not committed.
- **CI workflow + canaries (condition 5, scanned-field portion):** `scan.yml` runs `scan:canary` (gate self-test) then `scan-changed.mjs` on `git diff` changed `data/**/*.jsonl`, failing on any blocking finding. I confirmed via `template.test.ts` (passing) that the canary fixtures (`aws-key.jsonl`, `github-pat.jsonl`) are valid `SanitizedSession` records whose planted-in-**content** secrets are caught (`precheckRecord(...).ok === false`). Note: the canaries only plant secrets in message `content`, so the self-test does not exercise the B1 blind spot — add a canary with a secret in `projectKey`/`meta` once B1 is fixed.
- **INCIDENT-RESPONSE.md (condition 6):** Covers every design-doc-required step — contributor rotation notice (Step 1), HF removal + re-release (Step 2), git history rewrite via `git filter-repo` or repo rotation (Step 3), public incident record (Step 4), and prevention rule + pinned-engine bump (Step 5) — with named roles and a T0-anchored timeline. Complete.

---

## Note on the fix

B1 and M1 are the same root cause (unscanned published fields) but distinct leak classes (blocking secret vs. non-blocking PII), so both fixes are needed: (a) any blocking finding anywhere in the serialized bytes must refuse, and (b) `projectKey` must be normalized like `cwd`. M2 closes the parity claim. I did not modify any implementation (review-only); the temporary PoC test was deleted after capturing its output.

---

## Round 1 re-review (delta only)

Re-reviewed the implementer's fix delta: `packages/publisher/src/{precheck.ts, export.ts, parity.ts}`, `templates/community-data-repo/scripts/scan-changed.mjs`, `tests/canary/meta-projectkey.jsonl`, and tests. Rebuilt dist and re-ran my own adversarial PoC (temp test, since removed). Gates: `npm run typecheck` PASS, `npm run build` PASS, `npx vitest run` = **140 passed (30 files)** — matches expected 140.

### B1 — RESOLVED (verified)

`precheckRecord` now runs the structured `scanSession` **and** `scanRawBytesBackstop`, which scans the EXACT serialized bytes as a synthetic `content` field in overlapping 100k windows (`precheck.ts:119-140,166-197`). The real publish path passes the literal exported string (`pr.ts` → `assertPrecheckClean(record.jsonl)`; `rawBytes = record` when a string is given, `precheck.ts:174`), so the scanned bytes equal the staged bytes (`fileContents = jsonl + "\n"`).

My PoC (rebuilt dist) — every field that survives into the exported bytes now refuses:

```
meta.contributorAlias → ok=false   meta.toolVersion → ok=false   meta.license → ok=false
session.sessionId    → ok=false   session.sourceId → ok=false   schemaVersion  → ok=false
```

- **Window seam (task 1a):** step = 100000 − 4096 = 95904, so consecutive windows overlap 4096 chars; any secret ≤ 4096 chars crossing a boundary is fully contained in the next window. Empirically, a PAT planted at raw offset 99990 spanning `[99990,100030)` across the 100000 boundary → `ok=false` (refused). Realistic secrets (< 200 chars) cannot escape the seam.
- **Exact bytes (task 1b):** the backstop scans `record.jsonl` — the literal string that becomes the committed file — not a re-serialization. Confirmed the staged bytes equal the prechecked bytes.
- **Synthetic-field semantics (task 1c):** no miss observed. `projectKey` is no longer attacker-injectable — `exportSession` recomputes it from `cwd` (see M1), so a planted `projectKey` secret is discarded; a secret reaching the bytes via `cwd` is caught by both passes (`ok=false`).
- **No false-positive regression (task 4):** a realistic clean session (UUID `550e8400-…`, real paths, two base64 blobs in tool output, hex token) → `ok=true`, 0 blocking. The raw backstop over escaped JSON does not trip on legitimate high-entropy content. (Windows are 100k < the 200k cap, so no truncation-induced `redos-guard`.)

### M1 — RESOLVED as scoped (verified)

`exportSession` re-derives `projectKey` from the sanitized `cwd` (`publishedProjectKey`, `export.ts:75-78,138-141`); null/empty cwd → fixed `REDACTED_PROJECT_KEY = 'redacted-project'`. The published `projectKey` now carries no more PII than `cwd` and is consistent with it across POSIX and Windows cwd shapes (`encodeProjectKey` = non-alnum→`-`, no username unless `cwd` still contains one). This is exactly the fix my finding requested. **Residual (out of scope, noted):** `projectKey` is only as clean as `cwd`, and `cwd` username/path normalization is L3 (non-blocking) — a contributor who leaves the L3 path finding `pending` ships the raw username in *both* `cwd` and `projectKey`. That is the pre-existing "L3 is advisory" design (slices 2/3), not this delta. **Minor collision note (task 2):** two cwds differing only in non-alnum chars collide to one `projectKey`, but `projectKey` is not used in the record file path (`data/<schema>/<alias>/<sessionId>.jsonl`), so no record is overwritten — cosmetic only.

### M2 / m1 — RESOLVED for the engine pin, but the fix introduces a NEW Major (M2b)

`scan-changed.mjs` now reads each record's `*.provenance.json` sidecar and calls `checkEngineParity`, failing CI on a mismatch (`scan-changed.mjs:56-67`) — this closes m1 (sidecar now inside the scan boundary) and the `sanitizerPackageVersion` / `gitleaksVersion` engine-pin case. I doctored each of the three version fields and confirmed `checkEngineParity` returns `ok=false` with a precise message per field. **Absent-sidecar = `console.warn`, not fail (task 3):** acceptable — the secret scan (`precheckRecord`) runs unconditionally regardless, so a missing sidecar is not a leak path; parity is a secondary integrity check. Minor suggestion: since `exportSession` always writes a sidecar, its absence signals a hand-crafted/malformed contribution and could reasonably fail-closed.

#### M2b — **Major (NEW, non-security / availability)** — `rulesetVersion` strict-equality parity breaks the documented additive-custom-rules design

**Files:** `packages/publisher/src/parity.ts:34-38`, `templates/community-data-repo/scripts/scan-changed.mjs:36,56-64`, `packages/sanitizer/src/ingest.ts:277-287`.

`checkEngineParity` compares the **full** `rulesetVersion` for exact equality. But `rulesetVersion = gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>`, and `custom@<hash>` is derived from the custom rules in effect (`custom@none` when empty). The design (planning-context D3) explicitly has **CI apply the community's committed custom rules additively**, while contributors stamp with only their own (often none). So the instant a community activates `sanitizer.custom-rules.json` (the documented, template-provided feature), CI computes `custom@<communityHash>` while every contributor record is stamped `custom@none` → `checkEngineParity` reports a `rulesetVersion` mismatch → **CI fails every legitimate contribution.**

PoC confirmed: contributor stamp `…+custom@none` vs CI engine `…+custom@ab12cd` → `checkEngineParity(...).ok === false` (`rulesetVersion` mismatch). The default template ships only `sanitizer.custom-rules.example.json` (no active `.json`), so the shipped tests and canaries pass — the bug is latent until an operator enables custom rules.

This **fails safe** (over-blocks, never under-blocks → no leak), so it does not affect the B1/M1 security verdict, but it silently sabotages the primary contribution flow the design promotes.

**Fix.** Compare the engine-pin fields strictly (`sanitizerPackageVersion`, `gitleaksVersion`) and compare only the **baseline** ruleset segment (`gitleaks@…+mosga-l3@…`) for `rulesetVersion`, allowing the `custom@…` segment to differ (additive by design). Add a template test: a contributor `custom@none` record against a CI engine with a community custom rule must PASS parity (baseline identical) while a `gitleaks`/`mosga-l3` version drift still FAILS.

### Round 1 verdict: **NEEDS-FIX (1 Major, non-security)**

- **B1 (Blocker) — RESOLVED.** The leak class is closed and verified with a rebuilt-dist PoC across every unscanned field, the window seam, and the exact-bytes path.
- **M1 (Major) — RESOLVED as scoped.**
- **M2 / m1 — RESOLVED**, but the fix introduces **M2b (Major, non-security/availability)**: `rulesetVersion` strict parity breaks the additive-custom-rules feature and would fail every contribution once a community enables custom rules.

The security gate (no secret survives to a published artifact) is **CLEAN and verified**. The one outstanding item, M2b, fails safe and does not manifest in the default template; it should be fixed before any community enables custom rules. If the team accepts shipping the default template with M2b tracked as a follow-up, there is no security blocker.

---

## Round 2 re-review (M2b fix delta)

Re-reviewed the M2b fix: `parity.ts` (`splitRulesetVersion` + baseline-only comparison, fail-closed on null provenance — authored by impl-publish), `parity.test.ts` and `scan-changed.mjs` (test + fail-closed sidecar — completed by the LEAD after impl-publish's session hit a spend limit mid-fix). I authored none of it → still a valid non-author reviewer. Gates I ran myself: `npm run typecheck` exit 0, `npm run build` exit 0, `npx vitest run` = **143 passed (30 files)**; `scan-canary.mjs` exit 0 (all 3 canaries caught, incl. `meta-projectkey`); `scan-changed.mjs` exercised across 4 sidecar scenarios (below).

### M2b — RESOLVED (verified)

`checkEngineParity` now compares `sanitizerPackageVersion` and `gitleaksVersion` strictly, and for `rulesetVersion` compares only the **baseline** segment (`gitleaks@…+mosga-l3@…`) via `splitRulesetVersion`, letting the additive `custom@…` segment differ (`parity.ts:24-28,80-86`).

- **Parse-edge robustness (task 1).** I probed `splitRulesetVersion` against pathological inputs. Every genuine baseline mismatch FAILS; only inputs whose baseline is byte-identical to CI PASS:

  | stamped `rulesetVersion` | result |
  | --- | --- |
  | `gitleaks@v0.0.0+mosga-l3@0.1.0` (no custom seg) | FAIL (baseline) |
  | `gitleaks@v0.0.0+mosga-l3@0.1.0+custom@none` | FAIL (baseline) |
  | `gitleaks@v8.18.4+custom@x+mosga-l3@0.1.0` (marker injected early → truncates baseline) | FAIL (baseline) |
  | `…+custom@none+custom@EVIL` (double custom) | PASS — baseline intact, `EVIL` only in ignored additive segment |
  | `…+mosga-l3@0.1.0+EVIL` (trailing junk, no custom) | FAIL (baseline) |
  | `` (empty) | FAIL (baseline) |
  | `…+custom@abc123` (M2b: same baseline, diff custom) | PASS |
  | exact match | PASS |

  No parse edge lets a genuine baseline mismatch pass: `baseline` is the literal prefix before the FIRST `+custom@`, compared with `!==`; equal baselines ⇒ equal gitleaks tag + mosga-l3 version. The no-`+custom@` case sets `baseline = whole string`, so a weaker baseline still differs from CI's and FAILS. Marker-injection only truncates the stamp's baseline (→ differs → FAIL); it cannot alter CI's baseline. `gitleaksVersion` is also checked independently and strictly, and `mosga-l3`/`sanitizerPackageVersion` move in lockstep (same package, strictly checked) — defense in depth. **And even a fully-defeated parity check cannot cause a leak: `precheckRecord` scans the bytes unconditionally with CI's own engine; parity is a secondary integrity check, not the leak gate.**

- **Regression test is non-tautological (task 2).** `parity.test.ts:52-65` builds two DIFFERENT full `rulesetVersion` strings sharing one baseline (`custom@none` vs `custom@ab12cd34`) and asserts PASS — this exact case FAILED before the fix. The complementary `parity.test.ts:67-79` (baseline differs, custom matches → FAIL) proves the comparison is baseline-only, not string-equality. Genuine guard.

- **Fail-closed sidecar, end-to-end (task 3 + M2/m1 re-confirm).** I ran `scan-changed.mjs` over generated fixtures (fake-only, cleaned up after): valid record + matching sidecar → exit 0; **no sidecar → `MISSING PROVENANCE`, exit 1 (fail-closed)**; doctored baseline (`gitleaks@v0.0.0`) → `VERSION MISMATCH … ruleset baseline`, exit 1; custom-only diff (`custom@deadbeef`) → exit 0 (M2b holds in CI). The fail-closed path does not regress the canary self-test: `scan-canary.mjs` is a separate script with no sidecar logic (it calls `precheckRecord` directly), and the canary fixtures under `tests/canary/` are never fed to `scan-changed.mjs` (the workflow scopes it to `data/**/*.jsonl`).

### Security verdict re-confirmed (task 4)

The delta touched only `parity.ts` / `parity.test.ts` / `scan-changed.mjs`. `precheck.ts` (B1 backstop) and `export.ts` (M1) were **not** modified (mtimes 07:05, predating the parity delta 07:23–08:31; grep confirms `scanRawBytesBackstop`/`RAW_SCAN_WINDOW`/`mergeBlocking` and `publishedProjectKey`/`REDACTED_PROJECT_KEY`/`encodeProjectKey` intact). The `meta-projectkey` canary — a fake PAT in `meta.toolVersion` + a fake AWS key in `session.projectKey` — is caught by `scan-canary.mjs` with 2 blocking findings, live-proving the B1 backstop still covers the previously-unscanned fields. B1 + M1 remain RESOLVED.

### Trivial (note, non-blocking)

`scan-changed.mjs:79` prints "at least one record still contains a blocking finding" as the summary even when the actual failure was a version mismatch or missing sidecar (not a blocking finding). Cosmetic log wording only; the correct per-item errors are printed above it and the exit code is right.

### Round 2 verdict: **CLEAN**

B1 (Blocker), M1, M2, m1, and M2b are all RESOLVED and independently verified. No new findings beyond one Trivial log-wording nit. The security gate — no secret survives into a published artifact, and a local/CI engine divergence is a visible failure — holds. Ship it.
