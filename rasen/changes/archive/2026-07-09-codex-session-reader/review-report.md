# Review Report — `codex-session-reader`

**Reviewer:** reviewer-codex-reader (author ≠ verifier)
**Scope:** uncommitted working-tree changes vs `origin/main` on `worktree-codex-session-reader`
**Method:** full diff read + elftia reference cross-check + downstream consumer trace (daemon `/api/reviews`, `buildEnvelope`, sanitizer gate) + `npx vitest run packages/session-readers` (34 passed) + `npm run typecheck` (clean).

## VERDICT: FINDINGS — Blocker: 0, Major: 2, Minor: 3, Trivial: 1

The core reading/parsing slice is correct, never-throws as specified, and the non-text marker works for the common image path. Two Major issues concern the boundary where this change makes codex reachable to downstream consumers. The lead should decide whether Major-1 blocks the slice.

---

## MAJOR

### M1 — Codex sessions are published mislabeled `sourceCli: "claude-code"` (reachable provenance defect)

- **Where:** `packages/daemon/src/envelope.ts:25` (untouched consumer) reached via `packages/daemon/src/app.ts:232-241` (`POST /api/reviews`), enabled by the new registration in `packages/session-readers/src/adapter/registry.ts:30`.
- **What:** Registering `codexAdapter` makes `getAdapter('codex')` resolve, so `POST /api/reviews` will `parseTranscriptToMessages` a codex rollout and call `buildEnvelope(ref, messages)`. `buildEnvelope` hardcodes `meta.sourceCli: 'claude-code'`. The published PR body prints this verbatim (`packages/publisher/src/pr.ts:391` → `source CLI | claude-code`). So a codex session flows through browse → review → export and lands in the contributed dataset **labeled as Claude Code**.
- **Why it matters:** This is a data-provenance corruption in the published output of a data-contribution tool. It is now reachable (not theoretical) — `/api/reviews` accepts any `sourceId`, and the proposal itself claims the daemon routes "pick codex up." The proposal's Impact section reasons only about `ParsedMessage`/`CliProjectRef`/`CliSessionRef` and misses that the same pipeline stamps `SanitizedSessionMeta.sourceCli`. Note also `SOURCE_CLI_VALUES = ['claude-code']` (`packages/contracts/src/envelope.ts:10`) does not include `'codex'`, so the hardcode is *masking* the missing enum value — deriving `sourceCli` from `ref.sourceId` today would fail schema validation instead.
- **Fix options (lead's call):**
  1. **Wire provenance now:** append `'codex'` to `SOURCE_CLI_VALUES` and set `meta.sourceCli` from `ref.sourceId` in `buildEnvelope` (small, additive per the enum's own D7 note). This is a contract+consumer edit the design listed as a Non-Goal, so it's a conscious scope expansion.
  2. **Gate codex out of the export path this slice:** reject non-`claude-code` sources in `POST /api/reviews` (or make the picker read-only for codex) so codex is browsable but not exportable until provenance is wired. Keeps the slice's "reading only" scope honest.
  - Shipping as-is (codex fully exportable, mislabeled) should be an explicit, recorded decision, not a silent gap.

### M2 — Scaffolding short-circuit drops the non-text marker (safety-critical "mark, not strip" violation)

- **Where:** `packages/session-readers/src/parsers/codexRollout.ts:252-261`.
- **What:** For a `role=user` message the flow is: join `input_text` → `if (content && isScaffoldingUserTurn(content)) continue;` (line 255) → *then* `collectNonTextParts` (line 256). The scaffolding `continue` fires **before** non-text collection. So a user `message` whose joined `input_text` starts with `<environment_context>` / `<user_instructions>` **and** also carries a non-text part (e.g. `input_image`) is skipped whole — the image marker is never stamped, and the human-review gate (`collectNonTextItems` → `computeGate.nonTextPending`, `packages/sanitizer/src/scan.ts:515-546`) never fires for it.
- **Why it matters:** This is exactly the dropped-marker class the non-text contract exists to prevent — a non-`input_text` part silently lost, letting a session that contained an image export without the mandated human gate. Likelihood is low (codex-injected scaffolding turns are text-only), but the parser makes no guarantee scaffolding turns lack image parts, and a user can author a prompt whose text begins with those tags while attaching an image. Contrast the Claude path (`parseClaudeSession.ts:84-123`), which re-scans *all* raw entries (including non-materializing meta/scaffolding rows) via the `lastEmitted` fallback and never lets a skip drop a marker — the inline codex approach regresses on that guarantee.
- **Fix:** collect `nonText` before the scaffolding check; if `nonText.length > 0`, still emit a marked message (empty `content` is fine, matching the accepted image-only-turn deviation) even when the text is scaffolding. Only skip when it is scaffolding **and** has no non-text part. Add a fixture: scaffolding-prefixed user turn + `input_image` part → asserts a message with `nonTextContent.blockTypes` containing `input_image` is emitted.

---

## MINOR

### m3 — `message` with a role other than user/assistant is skipped with no marking
- **Where:** `codexRollout.ts:250-270`. The `if (role === 'user') … else if (role === 'assistant')` has no else; any other role (`system`/`developer`/`tool`/absent) drops the whole message, non-text parts included.
- **Why:** Design D1 scopes marking to user/assistant, so this is within the documented design, but the task's safety contract ("any content part not input_text/output_text must stamp") is broader. Low real-world likelihood (codex non-user/assistant messages are text). Consider a catch-all that at least scans `payload.content` for non-text parts and emits a marked message if any are present.

### m4 — Content part lacking a string `type` is silently dropped
- **Where:** `codexRollout.ts:101-110` (`collectNonTextParts`) requires `typeof p.type === 'string'`; a part like `{ image_url: '…' }` with no `type` yields `t = null` and is neither surfaced as text (`joinContentText`, line 83-93) nor marked. A narrow silent-loss path against the contract. Codex parts always carry a `type`, so likelihood is low; if defensiveness is wanted, mark a sentinel (e.g. `'unknown'`, as the Claude path's `blockType` does at `parseClaudeSession.ts:41-43`) for typeless parts.

### m5 — Test gaps on load-bearing branches
- `codex-parse-layer.test.ts` pins the happy image marker + pure-text-unmarked case (good), but does **not** cover: the M2 scaffolding+image drop (the untested buggy branch), the `compacted` fallback (`codexRollout.ts:237-244`), `reasoning.summary` → `thinking` emission (line 272-278), and `custom_tool_call` / `apply_patch` raw-input passthrough (line 290-307). The tool-normalize helpers are covered indirectly via the shell test only; `update_plan` → `TodoWrite` and the cmd `/c` wrapper branch are untested. None are regressions, but the parser's tolerant branches are the ones most likely to drift with codex format changes — worth a fixture each.

---

## TRIVIAL

### t6 — Duplicated scaffolding/text helpers across the two files
`SCAFFOLDING_PREFIXES`, `isScaffolding`/`isScaffoldingUserTurn`, and `joinInputText`/`joinContentText` are near-duplicated between `adapter/codexAdapter.ts` and `parsers/codexRollout.ts`. Acceptable given the deliberate ~300-line util-cap split (D4) and that the two serve different call sites; noting only for future consolidation.

---

## What is correct (verified, not flagged)

- **Enumeration:** bounded date-tree walk (`MAX_WALK_DEPTH = 8`), pure `readdirSync`/`statSync` in try/catch that degrades to empty, single `scanCodexRollouts` feeding both list methods, 128 KB/60-line prefix with partial-final-line drop — all match elftia and the spec. `.jsonl.zst` is filtered at `walkRollouts` (`codexAdapter.ts:193`) so it is recognized but never enumerated (D2); the elftia divergence (elftia listed `.zst` with a null-meta stub) is the intended one.
- **Parser mapping:** `response_item`-only hard gate (line 246) correctly ignores the `event_msg` mirror (test asserts no doubling); `call_id` merge map, orphan-output drop, file-order emit, `compacted` summary-as-assistant fallback, and the `{output, metadata}` envelope unwrap with nonzero `exit_code` → `error` all match elftia and the spec.
- **Tool normalize:** `codexToolNormalize.ts` is verbatim-identical to the elftia source (only comment wording changed: "renderer" → "shared"). No logic drift; the cmd `/c` and Windows host-shell handling is preserved.
- **Non-text marker, common path:** image part on a normal user turn is marked (`input_image` in `blockTypes`) and a pure-text turn is unmarked — the tested, load-bearing safety behavior holds. Marker shape matches `NonTextContentMarkerSchema` and feeds `collectNonTextItems` → `computeGate` correctly.
- **ParsedMessage shape:** `sdkUuid`/`parentUuid: null`/`role`/`content`/`sdkMessageType`/`timestamp` match what the sanitizer (`scan.ts:80-108`) and `buildEnvelope` consume; synthesized `randomUUID` + `parentUuid: null` are consistent with the reasoning in D1. Typecheck clean, 34 session-readers tests green.
- **Registry/index/test edits** (`registry.ts`, `index.ts`, `registry.fake-adapter.test.ts`) are the minimal correct additive changes.

## Accepted deviations (not re-flagged, per brief)
- Raw part type `input_image` surfaced in `blockTypes` (design-authoritative).
- Image-only user turn emitted with empty `content` + marker.

---

## Round 1 re-review

Re-reviewed ONLY the fix delta (separate fixer, not the implementer) against the prior findings. Verified from disk: typecheck clean, 44/44 tests green on the touched packages (`session-readers` + daemon `envelope.test.ts`); lead verified 245/245 full suite and `rasen --strict validate` passes.

### Prior findings

- **M1 (provenance mislabel) — RESOLVED.** `packages/contracts/src/envelope.ts:10` appends `'codex'` to `SOURCE_CLI_VALUES` (additive, non-breaking, the exact D7 widening). `packages/daemon/src/envelope.ts:26` now sets `sourceCli: SourceCliSchema.parse(ref.sourceId)` — derived from the originating adapter, failing closed (zod throw) on an unknown id rather than mislabeling. `packages/daemon/src/__tests__/envelope.test.ts` pins codex→`codex`, claude-code→`claude-code`, and `bogus`→throws. No other `SOURCE_CLI_VALUES` consumer breaks (only `contracts/index.ts` re-exports it). No spec delta needed: the `session-contracts` "extensible enum defaulting to claude-code" scenario only asserts claude-code is accepted and the enum is extensible — both still true; the design gained a `## Review-round-1 amendment` recording the Non-Goals crossing. Confirmed.

- **M2 (scaffolding short-circuit drops marker) — RESOLVED.** `codexRollout.ts:258` now collects `nonText` BEFORE the scaffolding check; a scaffolding turn bearing a non-text part emits a marked empty-content message (`:263`), and only a pure-text scaffolding turn is skipped. Pinned by the "marks a scaffolding turn carrying a non-text part…" test (image survives as marked `''` message).

- **m3 (non-user/assistant role skipped unmarked) — RESOLVED.** New `else` branch (`codexRollout.ts:277-285`) marks non-text parts on unknown-role messages while correctly excluding BOTH text channels (`input_text` and filtered `output_text`) so a pure-text system/developer turn stays skipped. Pinned by the m3 test. Note: text on such messages is still dropped (empty content) — unchanged from round 0 / elftia and within design D1's user/assistant scope; not a leak (the text is absent from the export, hence nothing to scan or publish).

- **m4 (typeless part dropped) — RESOLVED.** `collectNonTextParts` (`:108`) now maps a missing/non-string `type` to `'unknown'` instead of dropping it (mirrors the Claude path's `blockType` sentinel). Pinned by the m4 test.

- **m5 (test gaps) — RESOLVED.** New tests pin every previously-untested branch: M2 scaffolding+image, m3 unknown-role, m4 typeless, `compacted` fallback (incl. empty-summary no-emit), `reasoning.summary`→`thinking`, `custom_tool_call`+`custom_tool_call_output` apply_patch passthrough, and `update_plan`→`TodoWrite`.

- **t6 (helper duplication) — accepted-known**, unchanged (per util-cap split).

### New defects introduced by the fixes
None. One forward-looking note (Trivial): `buildEnvelope` now throws when `ref.sourceId` is not in `SOURCE_CLI_VALUES`. This is the intended fail-closed behavior and is unreachable today (both registered adapters' ids are in the enum), but it couples adapter onboarding to the enum — a future adapter registered without appending its id to `SOURCE_CLI_VALUES` will throw at `POST /api/reviews`. Worth a one-line reminder in the adapter-onboarding path; not blocking.

### Round-1 verdict: CLEAN — no Blocker/Major open. All prior findings (2 Major, 3 Minor) resolved and test-pinned; 0 new defects.
