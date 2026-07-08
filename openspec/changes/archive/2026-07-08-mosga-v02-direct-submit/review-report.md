# Review Report — mosga-v02-direct-submit (出口②)

**Reviewer:** reviewer-1 (independent; did not author the code)
**Date:** 2026-07-09
**Scope:** uncommitted working-tree diff on `main` (new package `@mosga/direct-submit`, daemon routes, contracts schemas, UI consent panel, root config, office-hours write-back)
**Review engine:** `openspec-gstack-review` (adapted to the uncommitted diff; repo has no `.claude/skills/review/checklist.md`, so the ranked security rubric from the review brief + a universal security/smell baseline were used).
**Independent verification:** `npm run typecheck` for direct-submit/daemon/contracts/ui — all green; `vitest run` over `packages/direct-submit` + `packages/daemon/.../submit.test.ts` — 6 files / 26 tests passed. No real network exercised.

---

## VERDICT: APPROVE WITH FINDINGS — 0 Blockers, 1 Major, 2 Minor, 2 Trivial

All four security-critical invariants (key isolation, backstop integrity, consent gate, mapper/dispositions parity) hold and are backed by asserting tests. The one Major is a **fidelity** gap (not security/privacy) in the Anthropic→OpenAI conversion for the primary provider class. Nothing found blocks the privacy/security posture of the slice.

---

## Ranked focus items (from the review brief)

### 1. Key leakage — CLEAN (no Blocker)
The provider key exists only server-side and only in the outbound auth header.
- Resolved server-side from env (`MOSGA_PROVIDER_KEY_<ID>` → `MOSGA_PROVIDER_KEY`) or a trusted local config path — never a request body or client-supplied path (`packages/direct-submit/src/keys.ts:41-62`; daemon passes `providerKeyConfigPath` from `AppOptions`, never from the request, `packages/daemon/src/app.ts:425-427`).
- Injected only as `x-api-key` / `Bearer` in `authHeaders` (`packages/direct-submit/src/submit.ts:49-58`). The outbound `body` is serialized **before** the key is attached (`submit.ts:90-103`), so the key is structurally absent from the scanned/sent body.
- Absent from every serialized artifact: `SubmissionReceiptSchema` (`packages/contracts/src/contribution.ts:89-104`), `ContributionConsentSchema` (`:21-36`), `ContributionMetaSchema` (`:57-71`), and all daemon responses. Error bodies are key-free: `KeyNotConfiguredError` echoes env-var **names**, not the value (`keys.ts:8-16`).
- Tests assert it: `keys.test.ts:45-77` (only in auth header; absent from body/receipt/consent/logs) and daemon `submit.test.ts:198-205` (receipt & body key-free, key only in header).
- Adversarial check: the 422 backstop response returns `blockingFindings` including `matchPreview`, but the backstop scans only the key-free body, so a preview can never carry the provider key. The generic 500 path re-throws transport errors; the default `fetchTransport` does not embed headers in thrown errors (`transport.ts:47-56`). Minor defense-in-depth note below.

### 2. Backstop integrity — CLEAN (Blocker-free)
- `scanOutboundBytesBackstop` scans the EXACT serialized outbound bytes (converted request + serialized meta) via `scanSession(syntheticSession(chunk), ruleset)` in overlapping 100k windows / 4096 overlap (`packages/direct-submit/src/backstop.ts:50-71`). Same window sizing as the publisher.
- The scanned bytes ARE the sent bytes — same `body` local in both send paths, no mutation between scan and send (`submit.ts:90-103`, `:144-154`).
- No allow-escape: the synthetic session is scanned fresh with default dispositions, so any L1/L2 (`secrets`/`custom`/`redos-guard`/`ruleset-compile-error`) finding is `blocking` and returned regardless of any upstream human `allow`. `assertOutboundClean` throws `SubmissionRefusedError` **before** any transport call (`backstop.ts:93-101`). L3 normalization is filtered out (non-blocking).
- Every send path is gated: single-shot scans before send; turn-by-turn scans each growing prefix before each send (`submit.ts:144-154`). There is no code path that builds a request and calls `transport` without a preceding `assertOutboundClean`.
- `packages/publisher/src/precheck.ts` is neither modified (git working tree clean under `packages/publisher/`) nor imported (grep of direct-submit/daemon finds only prose comments referencing the pattern). Slice-1 invariant respected.
- Tests: `backstop.test.ts:36-84` — secret in a message, secret reintroduced via `meta.contributorAlias`, human-`allow`ed secret, and L3-does-not-block all covered; each refusal asserts `requests` length 0.

### 3. Consent gate — CLEAN (Blocker-free)
- Both acknowledgments + content-bound hash enforced; absent/false/mismatch → `ConsentError` → 422 (`consent.ts:32-52`; daemon `app.ts:444`). Locked gate → 409 checked before `submit()` is ever called (`app.ts:412-418`), with `NotStampedError` as library-level defense in depth (`submit.ts:78`).
- `contentHash` is computed over the content actually sent: submit hashes `applied.session` (the reconstructed/sent session) via `computeContentHash` (`consent.ts:11-13`, canonical JSON), and the estimate endpoint returns the hash over the identical `applyDispositions(...)` derivation (`app.ts:394-398`). No TOCTOU: if any disposition changes between consent and submit, the hash mismatches → 422 (verified by daemon `submit.test.ts:174-184`). The meta turn is deterministically rebuilt from hashed session + validated consent + server-resolved versions — no free-form content can slip in unhashed.
- Consent recorded in provenance: `receipt.consent` (full record) and the meta `consent` ack block (`submit.ts:112`, `reconstruct.ts:56-61`). Tests: `consent.test.ts`, daemon `submit.test.ts`.

### 4. Mapper / dispositions parity — CLEAN
Submit derives the stamped session with `applyDispositions(state.session, state.report, state.mapper)` (`app.ts:412`), byte-identical to the export route (`app.ts:362`). `contributorAlias` comes from the mapper-stamped `session.meta`, so it matches what export would emit.

### 5. Conversion fidelity — see Major-1 below
Reconstruction round-trips text/thinking/tool_use/tool_result with roles preserved and system folded (`reconstruct.ts:77-134`; `reconstruct.test.ts:8-23`). Meta is the terminal user turn, well-formed (`reconstruct.ts:147-164`). OpenAI conversion via omnicross routes correctly (`reconstruct.test.ts:40-85`). **However, the omnicross request converter drops `thinking` blocks** — Major-1.

### 6. No real network in tests — CLEAN
All tests inject `recordingTransport` / a mock `submitTransport`; `fetchTransport` is never exercised. Planted secrets are obviously-fake canaries (`ghp_…`, `AKIA…`, `sk-FAKE…`) and sessions are hand-built (`_fixtures.ts:18-23`).

### 7. Cost estimate — see Minor-1
Token count is deterministic (`estimate.ts:25-35`) and surfaced before send (UI `SubmitPanel.tsx:66-77,187-198`); Mode A (turn-by-turn) is opt-in via `consent.replayMode`, default single-shot. But the cost figure ignores the selected provider/model pricing (Minor-1).

### 8. Scope hygiene — CLEAN (one Trivial)
Root config changes are minimal and justified (build/typecheck add `@mosga/direct-submit`; workspace dep; tsconfig path; vitest alias). Archived changes untouched. UI mirrors existing ReviewView patterns. Office-hours write-back is correctly scoped to 出口② only, leaving 出口① pending. One Trivial: a slice-3 `mosga-v02-tauri-shell/` scaffold dir is present untracked (Trivial-2).

---

## Findings

### Major-1 — omnicross request conversion silently drops `thinking`; thinking-only assistant turns can produce an invalid OpenAI request
**Files:** `packages/direct-submit/src/reconstruct.ts:77-87` (thinking reconstructed) → `node_modules/@omnicross/core/dist/chunk-5ZQBEOMD.js:112-213` (`convertAnthropicRequestToOpenAI` handles text/image/tool_use/tool_result only — **no `thinking` branch**).
**Severity rationale:** NOT a security/privacy issue — the backstop scans the post-conversion bytes, so dropped thinking is simply never sent. It is a **fidelity/robustness** gap and it contradicts the design.
- For OpenAI-format targets (the flagship class — DeepSeek et al.), assistant `thinking`/reasoning is silently discarded from the ingested trajectory. `design.md` (Format conversion, step 1) explicitly lists `thinking` blocks as part of the reconstruction that gets sent, and the meta `note` frames the payload as complete-minus-media; neither states that reasoning is stripped for OpenAI targets. Anthropic-format targets are unaffected (native request preserves thinking).
- Edge case → possible hard send failure: an assistant turn that carries **only** a `thinking` block (no text, no tool calls) reconstructs to `{role:'assistant',content:[thinking]}` and converts to `{role:'assistant',content:null}` with no `tool_calls` — a shape many OpenAI-compatible providers reject (400). This path is never exercised (mock transport), so it would surface only on a real send.
**Recommendation (pick one):** (a) before conversion, fold assistant `thinking` into the text block (or a tagged `<thinking>…</thinking>` prefix) so it survives to OpenAI targets and no null-content turn is produced; or (b) if reasoning is intentionally out of scope for OpenAI targets, say so explicitly in the meta `note` and the design's Limitation section, and guard against emitting a null-content assistant turn. Either way add a conversion test for a thinking-only assistant turn against an OpenAI-format target.

### Minor-1 — cost estimate ignores the selected provider/model; always uses DEFAULT_PRICING
**Files:** `packages/daemon/src/app.ts:386-399` (handler reads only `replayMode`; `providerId`/`model` are accepted but unused), `packages/direct-submit/src/estimate.ts:54-59` (defaults to `DEFAULT_PRICING`).
The `/submit/estimate` route takes `providerId` and `model` but neither selects a provider-specific price nor validates the provider exists; every estimate uses the DeepSeek-class `DEFAULT_PRICING`. `design.md` says cost should be "computed from a configured preset price the contributor verifies at consent time." Impact is bounded: the token count is authoritative and the UI discloses "cost is approximate and provider pricing may differ" (`SubmitPanel.tsx:194-196`), and cost is not a gate. Recommendation: thread the resolved preset's pricing (or at minimum validate `providerId` and note the pricing basis) into the estimate, or drop the unused params to avoid implying provider-specific pricing.

### Minor-2 — provider-key resolution error surfaced as HTTP 400 while spec implies a config-error class; and generic transport errors reach a raw 500
**Files:** `packages/daemon/src/app.ts:460-463` (`KeyNotConfiguredError` → 400), `app.ts:518-523` (uncaught errors → 500 with `err.message`).
`KeyNotConfiguredError` → 400 is defensible (client asked to submit to a provider with no configured key) and leaks no credential, but it is a server-side configuration state, not a malformed request; consider a clearer signal. More importantly, any non-mapped error (e.g. a transport/network failure) falls through to a generic 500 echoing `err.message` verbatim. The default `fetchTransport` does not embed the key in thrown errors, so this is defense-in-depth only, but a custom transport could. Recommendation: catch/normalize transport errors into a key-free daemon error rather than re-throwing to the generic 500.

### Trivial-1 — dead `replayMode` fallback in the submit route
**File:** `packages/daemon/src/app.ts:434`. `consent: { ...consent, replayMode: consent.replayMode ?? replayMode ?? 'single-shot' }` — `ContributionConsentSchema.replayMode` is required, so `consent.replayMode` is always defined; the top-level `SubmitBody.replayMode` (`app.ts:125`) is therefore dead. Consent being authoritative is correct behavior; just remove the unused top-level field/fallback for clarity.

### Trivial-2 — slice-3 scaffold present in the working tree
`openspec/changes/mosga-v02-tauri-shell/` (only `.openspec.yaml` + `auto-run.json`, no code) is untracked alongside this slice. The Tauri shell is explicitly out of scope for slice 2. No code bleed; just don't stage it with this change.

---

## Standards axis (summary)
No documented repo checklist was found. Against a universal security/smell baseline: code is clean, well-commented, ESM-consistent, zod-validated at the daemon boundary, and follows the established library-in-package / daemon-orchestrates shape. Only smell: the two Trivial items above. Worst standards issue: Trivial-1 (dead field).

## Spec axis (summary — vs proposal.md / tasks.md / specs)
Every ADDED requirement in `specs/direct-submit/spec.md` and `specs/review-daemon/spec.md` is implemented and test-backed (gate-unlocked-only, byte-exact backstop with no allow-escape, content-bound consent, key-never-leaked, reconstruction+conversion, replay modes+estimate, meta terminal turn, three daemon routes). Task 1 (gating cost model) is recorded in `design.md`. One spec-vs-impl divergence: the design's promise that `thinking` is part of the sent reconstruction does not hold for OpenAI-format targets (Major-1); and the design's "cost from configured preset price" is not realized (Minor-1). Worst spec issue: Major-1.

## Test coverage (delta)
New code paths are well covered: backstop (unit + 4 refusal/pass scenarios), consent (5 scenarios), keys (leak assertions + missing-key), reconstruction/conversion (round-trip + both format routes), submit modes, and daemon routes (providers/estimate/409/422/200). Gaps: no test for the OpenAI conversion of a thinking-only assistant turn (Major-1), and `fetchTransport` + provider-specific pricing are untested by design (real-network / disclosed-approximate).

---

# Round 2 (delta re-review)

**Date:** 2026-07-09 · **Scope:** ONLY the fix delta for round-1 Major-1 / Minor-1 / Minor-2 (plus the Trivial-1 cleanup the implementer folded in) — not a full re-review.
**Independent verification:** `vitest run` over `packages/direct-submit` + daemon `submit.test.ts` — 6 files / **29 tests** passed (was 26; +3); `npm run typecheck` (direct-submit, daemon) green.

## Per-finding resolution

### Major-1 — RESOLVED
`foldThinkingIntoText` (`reconstruct.ts:178-200`) folds each assistant `thinking` block into delimited `<thinking>…</thinking>` text **before** the omnicross converter runs, and is invoked inside `serializeOutbound` only on the OpenAI path (`submit.ts:64-84`); the Anthropic path stays native (thinking preserved verbatim). Thinking-only turns get a **leading** text block so converted content is never null. A defensive guard (`submit.ts:73-83`) throws locally if any assistant message would still serialize to null/empty content with no tool_calls — turning a regression into a clear error instead of a silent malformed send. Two genuine tests exist and assert behaviour, not just non-throw: `reconstruct.test.ts:72-92` asserts the outbound OpenAI body contains `<thinking>`, the actual reasoning text, AND the original assistant text; `:94-118` asserts a thinking-only turn sends, content is non-null, and the reasoning survives. Empty-content turns are still skipped upstream (`reconstruct.ts:128`), so the guard is true defense-in-depth.

### Minor-1 — RESOLVED
`resolveProviderPricing` (`estimate.ts:28-41`) resolves per-provider pricing from `PROVIDER_PRICING`, falling back to `DEFAULT_PRICING` and disclosing which via `pricingSource: 'provider' | 'default'`. The estimate route now validates the provider when named (404 on unknown), threads the resolved `pricing` into `estimate(...)`, and returns `pricingSource` in the response (`app.ts:391-411`). Test asserts `pricingSource === 'provider'` for deepseek (`daemon submit.test.ts:99-100`). Note (not a finding): `PROVIDER_PRICING` currently holds only `deepseek`; every other preset resolves to `'default'` — acceptable since the source is disclosed and token count is authoritative, but the table should grow as targets are added.

### Minor-2 — RESOLVED
Unmapped submit errors are now logged server-side and returned as a generic key-free `{ error: 'submission failed', code: 'SUBMIT_FAILED' }` 500 — no raw `err.message` echo (`app.ts:488-492`). `KeyNotConfiguredError` → 400 with stable `code: 'KEY_NOT_CONFIGURED'` (`:483-486`); all submit error bodies now carry stable codes (`GATE_LOCKED` / `CONSENT_INVALID` / `BACKSTOP_BLOCKED` / `NOT_STAMPED` / `KEY_NOT_CONFIGURED` / `SUBMIT_FAILED`). New test asserts the 400 + `KEY_NOT_CONFIGURED` code with nothing sent (`daemon submit.test.ts:147-185`). The empty-content guard Error (Major-1) also lands on this sanitized 500 path, so it cannot leak.

### Trivial-1 — RESOLVED (bonus)
The dead top-level `replayMode` fallback is gone; the route destructures `{ providerId, model, consent }` and documents that `consent.replayMode` is authoritative (`app.ts:437-439`).

## Security-invariant regression check (all HOLD)
- **Key isolation:** the fold operates only on request `messages`; the key is still attached after serialization in `authHeaders` and never enters the body. New tests keep the key in the header only. ✓
- **Backstop integrity:** ordering is **fold → convert → guard → `assertOutboundClean(body)` → key check → send** (`submit.ts:108-123`); the backstop scans the exact post-fold bytes. This is a net improvement — a secret in assistant `thinking` bound for an OpenAI target is now folded into the scanned body (previously it was dropped pre-scan and never sent, so no leak either way, but coverage is now uniform). Turn-by-turn scans each prefix post-serialize as before (`submit.ts:166-167`). ✓
- **Consent gate:** unchanged; `assertConsent` runs before request build and `contentHash` is over the session, not the folded request. ✓
- **Mapper/dispositions parity:** unchanged. ✓

## Round 2 verdict: CLEAN
All three findings (Major-1, Minor-1, Minor-2) are properly resolved with genuine asserting tests; Trivial-1 also cleaned up. No security invariant regressed; the backstop change strictly improves outbound coverage. No remaining findings. **Approve.**
