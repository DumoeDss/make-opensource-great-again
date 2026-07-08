# Tasks — mosga-v02-direct-submit

## 1. Token-cost estimation FIRST (gating — design-doc Next Steps 7)

- [x] 1.1 Sample real v0.1 session lengths (turn counts + approx tokens/turn) from the daemon's parsed envelopes; do NOT commit any real session data — record only the aggregate distribution.
- [x] 1.2 Compute the concrete cost estimate for small/medium/large sessions under Mode B (single-shot, linear) and Mode A (turn-by-turn, quadratic) at current DeepSeek-class pricing (verify the live price). Record the measured table in `design.md` (replacing the representative one).
- [x] 1.3 **Go/no-go gate**: report the estimate. Proceed with Mode B as default only if acceptable; if not, pick and document a truncation/summarization strategy (sliding window / compact-summary leverage / per-session budget) BEFORE continuing to the tasks below. **GO — Mode B default; real sessions ~10x longer than assumed but Mode B stays sub-$2 at max (~$1.56); Mode A confirmed catastrophic (~$4900 max) → hard opt-in only.**

## 2. Package scaffold

- [x] 2.1 Create `packages/direct-submit/` (`@mosga/direct-submit`, ESM, tsup, vitest, CLI bin), add to npm workspaces, deps `@mosga/contracts`/`@mosga/sanitizer`/`@omnicross/core@^0.1.2`/`@omnicross/contracts@^0.1.2`/`zod` (inter-package deps as `"*"`).
- [x] 2.2 Verify `@omnicross/core` (ApiConverter) and `@omnicross/contracts` (presets) resolve and typecheck from the new package.

## 3. Contracts schemas

- [x] 3.1 Add `ContributionConsent`, `ContributionMeta`, `SubmissionReceipt` zod schemas + types to `@mosga/contracts` and export them. Consent fields per design.md; none contain key material.

## 4. Request reconstruction + conversion

- [x] 4.1 `toAnthropicMessages(session)` — rebuild the Anthropic `messages[]` from `ParsedMessage[]` (text / thinking / `tool_use` from `toolCalls` / `tool_result` from `toolResults`, roles preserved). Append the `ContributionMeta` as the terminal user turn.
- [x] 4.2 Route by preset `apiFormat`: Anthropic presets send native to the messages endpoint; OpenAI presets convert via `@omnicross/core` `convertAnthropicRequestToOpenAI` and send to the chat-completions endpoint.
- [x] 4.3 Non-streaming send via an injectable transport (mockable); discard the completion body, capture `usage`. Document the text+tool-only replay limitation (non-text bytes not retained upstream) in the meta message.

## 5. Pre-send raw-bytes backstop (slice-1 inheritance)

- [x] 5.1 Implement `scanOutboundBytesBackstop(rawBytes, ruleset)` in the new package, replicating the `scanRawBytesBackstop` PATTERN (overlapping windows under the 200k cap, shared compiled ruleset, `scanSession` over a synthetic session). Do NOT import from or modify `packages/publisher/src/precheck.ts`.
- [x] 5.2 Scan the EXACT serialized outbound bytes (converted request + meta message); any L1/L2 blocking hit hard-refuses the send (no allow-escape); L3 does not block.

## 6. Consent gate + provenance

- [x] 6.1 Enforce consent before send: both acknowledgments true, recompute `contentHash` from the stamped session, refuse on absent/false/hash-mismatch. Record accepted consent in the `SubmissionReceipt` and echo the acknowledgment in the meta message.

## 7. Provider targeting + keys

- [x] 7.1 Load open-model presets from `@omnicross/contracts` + user-added targets; expose a key-free provider list.
- [x] 7.2 Read the user's key server-side from env / trusted local config (never a request body / client path). Use it only as the outbound auth header. Assert (test) it never appears in any serialized output or log.

## 8. Replay execution + estimation

- [x] 8.1 `estimate(session, provider, model, mode)` — token estimate without sending (Mode B linear, Mode A quadratic per the model).
- [x] 8.2 `submit(...)` — single-shot default: one request carrying the full conversation + meta message; turn-by-turn opt-in. Returns the `SubmissionReceipt`.

## 9. Daemon routes (MODIFIED review-daemon)

- [x] 9.1 `GET /api/providers` (key-free list).
- [x] 9.2 `POST /api/reviews/:reviewId/submit/estimate` → estimate, no send, 404 unknown review.
- [x] 9.3 `POST /api/reviews/:reviewId/submit` → derive stamped session (like `/export`); 409 locked, 422 invalid consent, block error on backstop hit, else key-free receipt.

## 10. UI consent dialog

- [x] 10.1 Consent dialog: target selection, shown token/cost estimate, ToS-risk + full-retention disclosure, explicit confirm; on confirm, POST submit with the consent record. Submit disabled while the gate is locked.

## 11. Tests

- [x] 11.1 Reconstruction/conversion: hand-built fixtures round-trip tool_use/tool_result; OpenAI-format target gets a converted request, Anthropic-format target gets the native request.
- [x] 11.2 Backstop: a fake secret planted anywhere in the outbound bytes (including in the meta message) refuses the send; L3 does not block; a human-`allow`ed secret still refuses.
- [x] 11.3 Consent: missing / unacknowledged / hash-mismatched consent all refuse; accepted consent is recorded in the receipt.
- [x] 11.4 Keys: mock-transport test asserts the key is only in the outbound auth header and in no session/meta/consent/receipt/log output.
- [x] 11.5 Gate: locked review → 409, no send; estimate endpoint sends nothing.
- [x] 11.6 All fixtures use obviously-fake secrets and fake sessions; no real provider calls, no real keys.

## 12. Open Question #3 write-back

- [x] 12.1 In `openspec/office-hours/agent-session-data-contribution.md` Open Questions #3, mark decided (date 2026-07-09): per-channel strategy — 出口② = informed consent + full retention (assistant messages retained for replay; ToS risk disclosed in-tool; explicit confirmation recorded in provenance).

## 13. Validate

- [x] 13.1 `npm run typecheck`/build + `vitest` across affected packages (`direct-submit`, `contracts`, `daemon`, `ui`) — all green. (typecheck + build all packages green; vitest 181/181 passed.)
- [x] 13.2 `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v02-direct-submit --json` passes.
