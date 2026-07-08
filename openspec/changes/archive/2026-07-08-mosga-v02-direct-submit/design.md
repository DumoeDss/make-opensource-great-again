# Design — mosga-v02-direct-submit

## Context

出口② consumes the exact artifact 出口① consumes: the gate-unlocked, stamped `SanitizedSession` returned by the daemon's `POST /api/reviews/:reviewId/export` (200). That session has passed the mandatory human gate (every blocking finding + non-text item dispositioned) and carries `meta.sanitized:true` + `sanitizationRulesetVersion` + `contributorAlias`. From there, 出口② replays it to a user-chosen open-model provider using the user's own key.

The user's ToS decision is fixed (2026-07-09): **informed consent + full retention** — keep the whole session (assistant messages included, replay needs them), disclose the ToS risk in-tool, send only after explicit confirmation recorded in provenance. This design does not re-open that question.

## Goals / Non-goals

- **Goal**: replay a sanitized session to a provider preset with the user's key, behind an informed-consent gate and a byte-exact pre-send backstop.
- **Goal**: a defensible token-cost model, so a contributor is never surprised by a large bill, and long sessions have a truncation path.
- **Non-goal**: modifying the publisher backstop or 出口① (slice-1 invariant); a self-hosted receiver (v2); proving the provider trains on the data (unverifiable — design doc Open Q5).

## Token-cost model (the design-doc hard requirement, Next Steps 7)

Let a session have `T` turns and `s` average tokens added per turn (user text + assistant text + tool input/output). Two replay modes:

### Mode A — faithful turn-by-turn re-generation (quadratic)

To reproduce assistant turn `i` as live traffic, POST the prefix of all prior messages (≈ `i·s` input tokens) and generate a throwaway completion. Summed over the session:

- Input tokens ≈ `s · Σ_{i=1..T} i` = `s · T(T+1)/2` ≈ **O(T²)**.
- Output tokens ≈ `T · s_out` (one generation per turn), linear.

This is the mode the design doc flags as "成本随轮数近似平方增长."

### Mode B — single-shot ingestion (linear, recommended default)

POST the entire conversation once (all user+assistant messages, ≈ `T·s` input tokens) plus the terminal meta turn, and consume ONE throwaway completion:

- Input tokens ≈ `T·s` ≈ **O(T)**.
- Output tokens ≈ `s_out` (one generation), constant.

The provider ingests the full multi-turn trajectory in a single inference call — which is exactly the "trajectory enters the provider's data pipeline as normal traffic" goal — at ~`T/2`× lower cost than Mode A. Because the terminal turn is the meta message (a user turn), the request is well-formed (ends on a user turn → one assistant completion), so Mode B needs no protocol hack.

### Measured cost table (impl Task 1 — MEASURED, replaces the representative one)

Sampled the local Claude Code corpus on 2026-07-09: 1,611 transcript files, 224 with user/assistant turns. Aggregate distribution only — no session bytes committed (sampler: overlapping-window read, prints aggregates only). Tokens approximated as serialized-turn-bytes / 4 (a conservative *over*-estimate: `toAnthropicMessages` strips uuids/timestamps/metadata, so real outbound tokens are lower).

Measured distribution:

- **Turns `T`**: min 1, p25 51, median 258, p75 691, p90 1,354, p99 4,886, max 6,283. (Far longer than the pre-measurement 10/40/120 assumption.)
- **Tokens/turn `s`**: p25 715, median **888**, p75 1,124, p90 1,512. (Lower than the assumed 1,500 — partly offsets the higher turn counts.)
- **Total tokens/session**: median 270k, p90 1.6M, p99 4.75M, max 6.84M.

Pricing used: DeepSeek-class open-model, input ≈ $0.28 / 1M, output ≈ $0.42 / 1M, `s_out ≈ 800`/generation (**representative — the tool returns the deterministic token count as authoritative and computes cost from a configured preset price the contributor verifies at consent time; pricing drifts**). `s = 888` (measured median) used across rows:

| Session (turns) | `T` | Mode B input tok | Mode B cost | Mode A input tok | Mode A cost |
| --- | --- | --- | --- | --- | --- |
| small (p25) | 51 | 46k | ~$0.013 | 1.18M | ~$0.35 |
| medium (median) | 258 | 230k | ~$0.065 | 29.7M | ~$8.39 |
| large (p90) | 1,354 | 1.20M | ~$0.34 | 815M | ~$228 |
| x-large (p99) | 4,886 | 4.34M | ~$1.22 | 10.6B | ~$2,970 |
| max | 6,283 | 5.58M | ~$1.56 | 17.5B | ~$4,911 |

### Go/no-go (impl Task 1.3) — **GO, Mode B default**

- **Mode B is acceptable across the real distribution**: median ~$0.065, p90 ~$0.34, worst-case real session ~$1.56 — linear, bounded, and surfaced by the mandatory pre-send estimate in the consent dialog before any send. The natural "large" (p90) bucket is ~6× the $0.055 pre-measurement ballpark, under the 10× hard-stop trigger; Mode B only crosses ~$0.55 above ~p93 (≈2,200 turns).
- **Mode A is disqualified as a default**: at real lengths it reaches ~$228 (p90) and ~$4,900 (max) — a shocking bill. It remains hard opt-in, and the estimate must be shown prominently before a Mode A send.
- **Deviation flagged**: real sessions are ~10× longer in turn count than the design's original 10/40/120 assumption. This does not change the recommendation (Mode B stays sub-$2 even at the maximum), but it makes two already-designed mitigations genuinely load-bearing rather than nice-to-have: (1) the mandatory estimate shown at consent time, and (2) a per-session budget ceiling for the long tail (`estimatedTokens` recorded in consent enables this). No truncation strategy is required to proceed under Mode B.

**Recommendation: Mode B (single-shot ingestion) is the default; Mode A is opt-in for contributors who have seen the (much larger) estimate.**

### Truncation / summarization options (if an estimate is unacceptable)

1. **Mode B default** already removes the quadratic term — often sufficient, no truncation needed.
2. **Sliding window**: replay only the last `K` turns (loses early trajectory; surfaced to the user).
3. **Compact-summary leverage**: Claude Code transcripts already carry `isCompactSummary` entries; fold older turns into their existing compaction so the ingested prefix shrinks without a fresh summarization call.
4. **Per-session budget + confirm**: the consent dialog shows the estimate; the user opts in per session, and a configurable ceiling refuses sessions above it until truncation is chosen.

**Impl Task 1 is gating**: measure the estimate over sampled v0.1 session token counts, record it in this design.md, and only proceed if acceptable under Mode B (else pick a truncation strategy first).

## Package + boundaries

`@mosga/direct-submit` (`packages/direct-submit/`, CLI bin for headless submit). Depends on `@mosga/contracts`, `@mosga/sanitizer` (backstop), `@omnicross/core` (ApiConverter), `@omnicross/contracts` (presets), `zod`. The daemon adds thin routes that call into it; the UI adds the consent dialog. Library-in-package, daemon-orchestrates — same shape as the rest of the monorepo.

### Where it hooks into the daemon flow

After gate-unlock. The submit route re-derives the stamped session exactly as `/export` does (`applyDispositions(state.session, state.report, state.mapper)`), refusing with 409 if the gate is locked — so submission can never run on an un-sanitized session. The held `PseudonymMapper` guarantees the same `contributorAlias` the export path would stamp.

## Format conversion

`SanitizedSession.messages` is isomorphic to the source Claude Code JSONL (Anthropic-shaped), so the request is reconstructable:

1. `toAnthropicMessages(session)` — rebuild the Anthropic `messages[]` from `ParsedMessage[]`: `content` text blocks, `thinking` blocks, `toolCalls[]` → `tool_use` blocks, `toolResults[]` → `tool_result` blocks, roles preserved. Append the `ContributionMeta` as the terminal user turn.
2. Route by the preset's `apiFormat`/`apiType`:
   - `anthropic` presets → POST the Anthropic request to `<api_base_url>` (`/v1/messages`).
   - `openai` presets (DeepSeek etc.) → `convertAnthropicRequestToOpenAI` (`@omnicross/core`) → POST to `<api_base_url>` (`/chat/completions`).
3. Non-streaming send; the completion body is discarded (ingestion only), but `usage` is captured for the receipt.

**Thinking on OpenAI-format targets (review Major-1).** The `@omnicross/core` Anthropic→OpenAI converter has no `thinking` branch: passed through as-is it would silently drop assistant reasoning for OpenAI targets (the flagship class, DeepSeek et al.) and could emit a `{role:'assistant', content:null}` turn for a thinking-only message (rejected by many OpenAI-compatible providers). Chosen fix: **fold** each assistant `thinking` block into delimited `<thinking>…</thinking>` text (`foldThinkingIntoText`) BEFORE handing the request to the converter, so the full trajectory (reasoning included) survives to OpenAI targets and no null-content assistant turn is produced. Folding was chosen over an explicit strip because the project's value proposition is the *complete* trajectory and the no-silent-truncation rule forbids dropping reasoning; the `<thinking>` delimiter keeps the reasoning machine-distinguishable from the reply. Anthropic-format targets are unaffected — the native request carries `thinking` blocks verbatim. A post-conversion guard asserts no assistant turn serializes to empty content with no tool calls, turning any regression into a clear local error rather than a malformed send.

**Limitation**: image/binary blocks are marked-not-stored upstream (readers keeps only `nonTextContent.blockTypes`, not the bytes — a slice-1 fixed fact), so replay is text+tool-structure only. The meta message discloses this so the ingested trajectory is not misrepresented as complete-with-media.

## Pre-send raw-bytes backstop (slice-1 inheritance)

Replicate the `scanRawBytesBackstop` PATTERN (do NOT import from / modify `packages/publisher/src/precheck.ts`). `scanOutboundBytesBackstop(rawBytes, ruleset)`:

- `rawBytes` = the EXACT serialized outbound request body (converted messages + meta message + params) — the literal bytes leaving the machine.
- Scan in overlapping windows (under the sanitizer's 200k per-field cap, same as the publisher) with the shared compiled ruleset via `scanSession(syntheticSession(chunk), ruleset)`.
- ANY Layer-1/2 blocking finding (secrets/custom/redos-guard/ruleset-compile-error) → **hard refuse the send**, no allow-escape, independent of the human gate. A real secret a human mistakenly `allow`ed, or one reintroduced by conversion/the meta message, is still caught here.
- L3 normalization is non-blocking (mirrors the gate/publisher semantics).

This is the byte-exact last line, symmetric with 出口①'s pre-write backstop. (A mild code duplication of ~30 lines; a future refactor could hoist the shared helper into `@mosga/sanitizer`, but that would require touching `precheck.ts`, which the slice-1 invariant forbids in this slice.)

## Informed-consent gate + provenance

`ContributionConsent` (in `@mosga/contracts`), required before send and bound to content:

| Field | Type | Purpose |
| --- | --- | --- |
| `consentVersion` | string | consent schema version (e.g. `"0.2.0"`) |
| `tosRiskAcknowledged` | boolean | must be `true` — user saw the ToS-risk disclosure |
| `fullRetentionAcknowledged` | boolean | must be `true` — user understands the full session incl. assistant messages is sent |
| `targetProviderId` | string | chosen preset id |
| `targetModel` | string | chosen model |
| `replayMode` | `'single-shot' \| 'turn-by-turn'` | which cost profile |
| `estimatedTokens` | number | the estimate the user was shown at confirm time |
| `contentHash` | string | sha256 of the stamped session — binds consent to the exact content |
| `confirmedAt` | string (ISO) | confirmation timestamp |

The submit route recomputes `contentHash` from the stamped session and refuses (422) if consent is absent, either acknowledgment is false, or the hash mismatches (consent for different content). The accepted consent is recorded in the `SubmissionReceipt` and echoed in the meta message's `consent` block. **No key material is part of consent.**

## Contribution meta message

`ContributionMeta` (in `@mosga/contracts`), rendered as the terminal user turn:

- `kind: 'mosga-contribution-meta'`, `metaVersion`, `toolVersion`, `sanitizationRulesetVersion`, `sanitizerPackageVersion`, `contributorAlias`, `license | null`, `sourceCli`, `sessionId`, a `consent` acknowledgment block, and a human-readable `note` disclosing this is a sanitized, community-contributed coding trajectory (and that non-text media is absent).
- Serialized deterministically into the turn text so both a human and a provider pipeline can parse it. It is part of the outbound bytes, so the backstop scans it too.

## Keys

The user's provider key is read server-side at send time from `env` (e.g. `MOSGA_PROVIDER_KEY` / a per-preset var) or a trusted local config file (same trust model as the daemon's `customRulesPath` — never a request body, never a client-supplied path). The key is used only as the outbound `Authorization` header. It never enters the exported session, the meta message, the consent record, the receipt, logs, or any daemon response. Tests assert the key never appears in serialized outputs.

## Daemon routes (MODIFIED review-daemon)

- `GET /api/providers` → open-model presets (`@omnicross/contracts`) + user-added targets; ids/names/models/format only, never keys.
- `POST /api/reviews/:reviewId/submit/estimate` `{ providerId, model, replayMode }` → `{ estimatedTokens, estimatedCost?, replayMode }` (no send).
- `POST /api/reviews/:reviewId/submit` `{ providerId, model, replayMode, consent }` → 409 if gate locked; 422 if consent missing/invalid/hash-mismatch; block error if the backstop hits; else replays and returns the `SubmissionReceipt`.

## Submission receipt

`SubmissionReceipt`: `submittedAt`, `targetProviderId`, `targetModel`, `replayMode`, `requestCount` (1 for single-shot, `T` for turn-by-turn), `usage {inputTokens, outputTokens} | null`, `contentHash`, `consent`, `backstopPassed: true`, `providerStatus`. Key-free by construction.

## Alternatives considered

- **Start the code CLI to replay (founder's original mechanism).** Rejected per the design doc's v0.2 decision: direct POST is a shorter link with transparent cost; the CLI was only a transport.
- **Mode A as default.** Rejected: quadratic cost with no offsetting benefit (Mode B already ingests the full trajectory). Mode A stays opt-in for contributors who specifically want per-turn live generation.
- **Import `scanRawBytesBackstop` from `@mosga/publisher`.** Rejected: it is not exported and depending 出口② on the publisher couples the two exits; and hoisting it to `@mosga/sanitizer` would require editing `precheck.ts`, forbidden by the slice-1 invariant. Replicate the ~30-line pattern instead.
- **Consent as a boolean flag.** Rejected: consent must be auditable and bound to content, so it is a recorded, hash-bound structure in provenance.

## Risks

- **Cost surprise**: mitigated by the mandatory pre-send estimate in the consent dialog, Mode B default, and the gating impl Task 1.
- **New network surface**: first outbound-calling package; mitigated by loopback-only daemon, env/local-config keys, mock-transport tests, and the byte-exact backstop over outbound bytes.
- **ToS exposure**: explicitly the user's informed decision (2026-07-09); disclosed in-tool and recorded. Out of scope to re-litigate.
- **Reconstruction fidelity**: `toAnthropicMessages` must round-trip tool_use/tool_result structure; covered by conversion tests against hand-built fixtures.
