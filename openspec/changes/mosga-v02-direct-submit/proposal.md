## Why

v0.1 shipped 出口① (dataset PR export). The design doc's Approach C is a two-exit architecture; 出口② (API direct-submit / replay) is the second exit — the private channel for contributors who have no HuggingFace/GitHub account (design doc Constraints), and the mechanism that puts sanitized coding trajectories into an open-model provider's ingestion path as normal API traffic, using the contributor's own key.

The sanitized-session pipeline already produces a gate-unlocked, stamped `SanitizedSession` (the daemon's `POST /api/reviews/:reviewId/export` 200 body — the same artifact 出口① consumes). This slice adds a new exit that consumes that same stamped session and replays it to a user-chosen provider. The user's ToS decision is already made (2026-07-09, do not re-ask): **informed consent + full retention** — 出口② keeps the complete session including assistant messages (replay requires them), discloses the ToS risk in-tool, and only sends after explicit user confirmation recorded in provenance.

Slice-1 (`mosga-v02-sanitizer-coverage`, shipped) closed the human-review-gate coverage gap so it generalizes across both exits, and left an explicit inheritance note: **出口② must have a pre-send raw-bytes backstop equivalent to the publisher's** (byte-level, no allow-escape, L1/L2 hit = block). This slice delivers that backstop as the byte-exact last line before send.

## What Changes

- **New package `@mosga/direct-submit`** (`packages/direct-submit/`): the 出口② core — provider targeting, session→request reconstruction + format conversion, replay execution, token-cost estimation, the pre-send raw-bytes backstop, the informed-consent gate, and the contribution meta message. Consumes `@mosga/contracts`, `@mosga/sanitizer` (for the backstop's compiled ruleset + `scanSession`), and the npm-published MIT packages `@omnicross/core` (ApiConverter, Anthropic↔OpenAI incl. streaming) and `@omnicross/contracts` (provider presets).
- **Token-cost estimation first (impl Task 1, gating)**: multi-turn faithful replay is ~quadratic in turn count. The design derives the cost model, compares a linear single-shot ingestion mode against the quadratic turn-by-turn mode at representative open-model pricing, and recommends the linear default; the concrete measured estimate over sampled v0.1 session lengths is impl Task 1, and continuation is conditional on that estimate being reported and acceptable (else a truncation/summarization strategy is chosen first).
- **Pre-send raw-bytes backstop**: replicate the `scanRawBytesBackstop` PATTERN in the new package (NOT importing/altering `packages/publisher/src/precheck.ts` — a slice-1 invariant). Scan the EXACT outbound request bytes (converted messages + meta message) with the shared compiled ruleset; any Layer-1/2 blocking hit hard-refuses the send, no allow-escape, independent of the human gate.
- **Informed-consent gate**: a `ContributionConsent` record (ToS-risk + full-retention acknowledgments, target, replay mode, shown estimate, content hash, timestamp) is required before send, bound to the exact stamped content by hash, and recorded in the submission provenance. Missing/invalid consent refuses the send.
- **Provider targeting + keys**: open-model presets from `@omnicross/contracts` (DeepSeek etc.) plus user-added targets; the contributor's own API key is read server-side from env/trusted local config at send time and **never** enters the exported/replayed data, the meta message, logs, receipts, or provenance.
- **Contribution meta message**: a `ContributionMeta` payload attached as the terminal (well-formed) turn of the replay, carrying provenance (tool/ruleset/sanitizer versions, contributor alias, license, consent acknowledgment) and a human-readable disclosure.
- **Daemon routes** (MODIFIED `review-daemon`): `GET /api/providers`, `POST /api/reviews/:reviewId/submit/estimate`, `POST /api/reviews/:reviewId/submit` — hooking submission into the existing review lifecycle after gate-unlock. **UI consent dialog** surfacing the estimate, the ToS-risk + full-retention disclosure, target selection, and the explicit confirm.
- **Contracts schemas**: `ContributionConsent`, `ContributionMeta`, `SubmissionReceipt` added to `@mosga/contracts`.
- **Open Question #3 write-back**: mark decided in `openspec/office-hours/agent-session-data-contribution.md` (date 2026-07-09, per-channel strategy: 出口② = informed consent + full retention).

## Capabilities

### New Capabilities

- `direct-submit`: 出口② replay engine — consumes a gate-unlocked stamped `SanitizedSession`, targets a provider preset with the user's own key, reconstructs and converts the request (via `@omnicross/core`), estimates token cost, runs the pre-send raw-bytes backstop, enforces the informed-consent gate, attaches the meta message, replays, and returns a key-free submission receipt.

### Modified Capabilities

- `review-daemon`: adds the provider-list, submit-estimate, and submit routes that drive `direct-submit` from the existing stateful review lifecycle.

## Impact

- **New package**: `packages/direct-submit/` (`@mosga/direct-submit`, with a CLI bin for headless submit). Added to npm workspaces.
- **New dependencies**: `@omnicross/core@^0.1.2` and `@omnicross/contracts@^0.1.2` (MIT, npm-published — verified). No new detection deps; the backstop reuses `@mosga/sanitizer`.
- **Consumes**: the daemon's stamped-session export (gate-unlocked); `@mosga/sanitizer` `compileRuleset`/`scanSession`; `@mosga/contracts` message model.
- **Network**: this is the first package that makes outbound network calls (to the user-chosen provider only). Keys are env/local-config only. All tests use a mock transport — no real provider calls, no real keys, no real session data.
- **Known limitation**: non-text content (images/binaries) is marked-not-stored upstream (readers retains only the marker, not the bytes), so replay is text+tool-structure only; the meta message discloses this.
- **Out of scope** (must not bleed in): the Tauri shell (slice 3); any change to `packages/publisher/src/precheck.ts` or 出口①; self-hosted receiving server (design doc v2); verifying whether the provider actually trains on the traffic (design doc Open Q5, unverifiable).
