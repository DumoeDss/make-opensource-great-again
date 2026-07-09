# Review Report — settings-provider-management

Reviewer: reviewer-spm (author ≠ verifier). Scope: current uncommitted working-tree diff vs HEAD, restricted to the settings-provider-management surface. Reviewed against `{proposal,design,tasks}.md` + `specs/` (design authoritative) and the omnicross secret-stack source. `rasen/` artifacts, `rasen/config.yaml`, and `rasen/changes/codex-session-reader/` ignored per instruction.

## Verdict

**CLEAN — no Blockers, no Majors.** 3 Minor + 2 Trivial findings, all robustness/UX/hygiene. The security-critical surface (ported crypto, key-free invariant, allowlist, four-way format conversion, persistence) is correct and well-tested. Full suite green: **325 passed / 1 skipped (54 files)**; the skip is a POSIX-only `0600`-mode test correctly gated off on Windows.

Findings by severity: Blocker 0 · Major 0 · Minor 3 · Trivial 2.

---

## Findings

### Minor 1 — `providerStore.getKey` throws on a wrong-key/tampered envelope, 500-ing submit instead of degrading
- **File:** `packages/daemon/src/providerStore.ts:214-218` (file-backed `getKey` → `box.decryptMaybe`) consumed at `packages/daemon/src/app.ts:602-605`.
- **Scenario:** User sets a key via the UI (stored as `enc:v1:` envelope). Later `master.key` is lost/rotated or the store entry is edited. On the next submit with no env/startup key for that provider, `resolveProviderKey`'s `storeKeyLookup` calls `getKey` → `SecretBox.decrypt` throws the (secret-free) "failed to decrypt a stored secret…" error. Because the `resolveProviderKey(...)` call sits **outside** the submit handler's `try` (which starts at `app.ts:607`), the throw propagates to the dispatch-level catch (`app.ts:718-720`) and returns HTTP 500 `{error: <that message>}` rather than a clean `KEY_NOT_CONFIGURED` / fallthrough.
- **Not a leak:** the error message contains no key bytes; the invariant holds.
- **Tension:** contradicts the `keys.ts:70-71` comment ("the store swallows its own read errors and never throws here") and the task 4.5 guarantee that corrupt store reads "never throw to a caller." `readJsonFile`/`keyStatus` are guarded; the decrypt path is not.
- **Suggested fix:** wrap the `box.decryptMaybe(value)` in `getKey` in a try/catch returning `undefined` on decrypt failure (treat an undecryptable entry as "no stored key" so env/startup tiers and `KeyNotConfiguredError` still apply), or move the `resolveProviderKey` call inside the handler `try` and map the decrypt error to `KEY_NOT_CONFIGURED`.

### Minor 2 — Custom-provider create does not reject an id colliding with an allowlisted preset
- **File:** `packages/daemon/src/app.ts:471-486` (POST `/api/custom-providers`) + `packages/direct-submit/src/providers.ts:81-90` (`resolveProvider`).
- **Scenario:** User creates a custom provider with `id: "deepseek"` (an allowlisted preset id). `createCustomProvider` only guards against collisions with *existing custom* providers, so it succeeds. Then `listProviders(mergedTargets())` emits **two** entries with id `deepseek` (the preset + the custom), and `resolveProvider("deepseek", …)` returns the **preset** (allowlist checked first), so the custom target is unreachable for submit/estimate — silently shadowed.
- **UI impact:** `SettingsPage` maps rows with `key={p.id}` and testids `key-status-${p.id}` / `provider-row-${p.id}`, so a duplicate id yields a React duplicate-key warning and colliding testids.
- **Suggested fix:** in the create route (or store), reject an `id` that is in `ALLOWED_PRESET_IDS` (409 `PROVIDER_EXISTS` or a 400 validation error), or dedupe preset-vs-custom in `listProviders`.

### Minor 3 — Changing an existing key requires clear-then-set (no in-place replace)
- **File:** `packages/ui/src/components/SettingsPage.tsx:268-296`.
- **Scenario:** The key `<input>`/save control renders only when `configured === false`; a configured provider shows only "清除密钥". To rotate a key the user must clear then re-enter. Consistent with the write-only model but an easy-to-miss UX gap.
- **Suggested fix:** optionally show a "替换密钥" affordance that re-reveals the input while configured. Low priority.

### Trivial 1 — Inaccurate comment in `keys.ts`
- **File:** `packages/direct-submit/src/keys.ts:70-71`. The comment states the store "swallows its own read errors and never throws here," which is false for the decrypt path (see Minor 1). Fix alongside Minor 1.

### Trivial 2 — Scope hygiene: unrelated changes intermingled in the working tree
- The working tree also contains **mosga-v04-batch** work outside this change's stated Impact: `packages/daemon/src/publish.ts` (+308), `packages/publisher/src/{batch,index,pr}.ts`, and `packages/{daemon,publisher}/src/__tests__/{publish-batch,batch}.test.ts`. These are not part of settings-provider-management (untracked dirs `rasen/changes/mosga-v04-batch-*` exist) and were **not** reviewed here. Flag for the lead — the two changes should be committed/reviewed separately.

---

## Verified correct (evidence)

**Security — ported secret stack (`packages/daemon/src/secrets/`)**
- Faithful file-level port of omnicross `envelope.ts` / `masterKey.ts` / `SecretBox.ts`: behavior verbatim, only constants renamed (`MOSGA_MASTER_KEY`, `~/.mosga/master.key`, error-message string) + `.js` import extensions. Diffed against `…/elftia/omnicross/packages/daemon/src/secrets/`.
- Crypto correct: AES-256-GCM, **fresh 12-byte IV per encrypt** (`envelope.ts:87`), 16-byte auth tag, `setAuthTag` verification on decrypt (`envelope.ts:113`), 32-byte key-length checks, wrong-key/tampered → secret-free error. No IV reuse, no missing tag check.
- Master key held in a separate `0600` keyfile, resolved lazily; env override never written to disk.

**Key-free invariant (routes, receipt, log, disk)**
- `PUT /api/provider-keys/:id` returns `{configured:true}`; `DELETE` returns `{configured:false}`; `GET` returns `keyStatus()` booleans only — no key bytes anywhere (`app.ts:511-538`). `keyStatus()` checks presence only, never decrypts.
- Submit error paths return secret-free bodies; the catch-all logs server-side and returns a generic 500 (`app.ts:642-651`). `KeyNotConfiguredError` names only env-var names.
- Integration test (`packages/daemon/src/__tests__/submit.test.ts:190`) proves end-to-end: set key over HTTP → submit → receipt key-free, outbound **body** key-free, key only in the `Authorization` header, and `provider-keys.json` on disk starts with `enc:v1:` and never contains the raw key.

**Allowlist enforcement**
- `ALLOWED_PRESET_IDS` = the 7 intended preset ids; enforced in **both** `listProviders` and `resolveProvider` (`providers.ts:69-90`). Estimate and submit both resolve via `resolveProvider(providerId, mergedTargets())` (`app.ts:551`, `597`). Non-allowlisted preset (`openai`) neither lists nor resolves — verified by `providerRoutes.test.ts:47-49` and `providers.test.ts`.

**Format conversion (four-way)**
- `serializeOutbound`/`authHeaders`/`outboundUrl` branch correctly on `anthropic` / `openai` / `openai-response` / `gemini` (`submit.ts`). Verified omnicross helpers: `buildGeminiApiUrl` → `…:generateContent` (key NOT in URL — in `x-goog-api-key` header), `buildOpenAIResponseApiUrl` → `/v1/responses`, `convertMessageToGemini` role map user→user / assistant→model. Responses remap `messages→input`, `max_tokens→max_output_tokens`. `parseUsage` extended for Gemini `usageMetadata`. **Backstop scans the final serialized `body` for all four formats** (`submit.ts:217`, `:274`). Covered by `formats.test.ts` (URL, auth header, thinking preserved, meta present, usage for all three shapes).

**Persistence**
- Atomic write (temp + rename), keys file `0600`, unreadable/missing files read as empty (`providerStore.ts:112-124`, `142-151`). Zod validation on routes (`ApiFormatSchema` enum of four; `HttpUrlSchema` rejects non-http(s) — `ftp` rejected in tests). Injected-first merge, dedupe by id (`mergedTargets`). `pickTarget` normalizes to the key-free `UserTarget` shape (defense-in-depth vs a stray key field; zod also strips).

**Frozen contracts**
- `data-testid="provider-list"` preserved (`SettingsPage.tsx:249`); no gate-copy (`Gate locked/unlocked`) or SubmitPanel changes. `AppShell.test.tsx` change is benign (adds the two new client mock methods). CLI flags thread through `server.ts` unchanged because `DaemonOptions extends AppOptions` and `startDaemon` spreads all options into `createApp`.

---

## Fix round 1

Fixer: fixer-1 (review-loop round 1). All fixes confined to this change's own files; the intermingled mosga-v04-batch files were not touched. Verified green: `npm run typecheck` clean; `npx vitest run --testTimeout=20000` → **330 passed / 1 skipped (54 files)** (was 325/1; +3 new tests here, the rest from the other in-tree session).

### Minor 1 → FIXED — `getKey` decrypt failure no longer 500s submit
- **Change:** wrapped `box.decryptMaybe(value)` in a try/catch in `providerStore.ts` `getKey` (`packages/daemon/src/providerStore.ts:214-227`); a lost/rotated master key or tampered `enc:` envelope now returns `undefined` (treated as "no stored key", secret-free) instead of throwing. The env/startup tiers and `KeyNotConfiguredError` then apply, so submit returns a clean 400 `KEY_NOT_CONFIGURED` rather than a dispatch-level 500. The thrown error carried no key bytes, so swallowing it leaks nothing.
- **Test added:** `packages/daemon/src/__tests__/submit.test.ts` — "an undecryptable store key (lost/rotated master key) degrades to KEY_NOT_CONFIGURED, not 500": stores a key under master key A, restarts pointing at a different (freshly generated) master keyfile over the same on-disk `enc:` envelope, submits → asserts 400 `KEY_NOT_CONFIGURED` and nothing sent.

### Minor 2 → FIXED — custom-provider create rejects an allowlisted-preset id collision
- **Change:** `POST /api/custom-providers` now rejects an `id` in `ALLOWED_PRESET_IDS` with 409 `{ code: 'PROVIDER_EXISTS' }` before touching the store (`packages/daemon/src/app.ts:474-491`; imported `ALLOWED_PRESET_IDS` from `@mosga/direct-submit` at `app.ts:13`). Matches the existing custom-id-clash error shape. PUT is unaffected — it only mutates existing custom ids, which a preset id can never become now. No dedupe was added to `listProviders` (rejecting at the source is sufficient and keeps the resolve/list contract single-sourced).
- **Test added:** `packages/daemon/src/__tests__/providerRoutes.test.ts` — "rejects a custom id colliding with an allowlisted preset (409, persists nothing)": posts `id: "deepseek"`, asserts 409/`PROVIDER_EXISTS`, empty custom list, and a single `deepseek` row in `/api/providers`.

### Minor 3 → FIXED — in-place key rotation without clear-then-set
- **Change:** `SettingsPage.tsx` gains a `replacing: Set<string>` state and a 更换密钥 affordance. A configured provider now shows 更换密钥 + 清除密钥; clicking 更换密钥 reveals the (empty) write-only input plus a 取消. A successful save (or cancel) exits replace mode. No stored value is ever rendered — the input always reveals empty. Existing testids (`key-input-`, `key-set-`, `key-clear-`, `key-status-`) preserved; new `key-replace-`/`key-replace-cancel-` added. (`packages/ui/src/components/SettingsPage.tsx`.)
- **Test added:** `packages/ui/src/__tests__/SettingsPage.test.tsx` — "rotates a configured key in place via 更换密钥, never showing the stored value": asserts no input while configured, that 更换密钥 reveals an empty input, saving calls `setProviderKey` with the new key, the input hides again, and neither the old nor new key appears in the DOM.

### Trivial 1 → FIXED — inaccurate `keys.ts` comment
- **Change:** updated the LAST-tier comment in `packages/direct-submit/src/keys.ts:70-72` to state the store swallows its own read **and decrypt** errors (a lost/rotated master key reads as "no key"), now that Minor 1 makes that true.

### Trivial 2 → NOT FIXED (intentional, out of scope)
- Scope-hygiene flag about mosga-v04-batch files intermingled in the working tree. This is a lead/commit-hygiene concern, not a code defect in this change, and the instructions explicitly forbid touching those files. Left as-is; flagged for the lead to commit/review the two changes separately.

---

## Re-review round 1

Reviewer: reviewer-spm (delta re-review, full prior context held). Verified each fix in code + confirmed the new tests exercise the real scenario (not trivial passes). Re-ran the affected suites: 4 files / 28 tests green. No new findings.

### Minor 1 → RESOLVED
- `providerStore.ts:214-227` — `getKey` now wraps `box.decryptMaybe` in try/catch, returning `undefined` on a decrypt failure. The catch body does not touch the thrown error (which is secret-free anyway), so no key/ciphertext bytes leak. The fix lives in the **file-backed** store (the only one that decrypts); the in-memory fake is unaffected as intended.
- Test genuinely exercises the crypto path: `submit.test.ts:261` stores a key under `master-a.key`, restarts pointing at a distinct freshly-generated `master-b.key` over the same on-disk `enc:` envelope, submits → asserts **400 `KEY_NOT_CONFIGURED`** (not 500). This is real GCM auth-tag failure, not a mock.

### Minor 2 → RESOLVED
- `app.ts:482-490` — POST `/api/custom-providers` rejects an `id ∈ ALLOWED_PRESET_IDS` with 409 `PROVIDER_EXISTS` before touching the store; `ALLOWED_PRESET_IDS` imported from the direct-submit barrel (`app.ts:13`, exported at `index.ts:33`). Error body carries only the id string — no key material.
- Confirmed the other two guarantees the lead asked about: the pre-existing duplicate-**custom**-id check still fires (`createCustomProvider` → `ProviderConflictError` → 409, covered by `providerRoutes.test.ts:139`); and **PUT is unaffected** — `updateCustomProvider` only mutates an existing custom id, and a preset id can no longer be created as a custom provider, so PUT can never reach one. Collision test (`providerRoutes.test.ts:117`) asserts 409, empty custom list, and exactly one `deepseek` (the preset) in `/api/providers`.

### Minor 3 → RESOLVED
- `SettingsPage.tsx` — `replacing: Set<string>` + `showKeyInput = !configured || isReplacing` (`:276`). A configured row shows 更换密钥 + 清除密钥; 更换密钥 reveals the write-only input, which binds to `keyInputs[p.id] ?? ''` and is **never seeded from any stored value** (`refresh` sets providers/customIds/keyStatus only, never `keyInputs`). Save and cancel both clear the input and exit replace mode. Existing testids (`key-input-`/`key-set-`/`key-clear-`/`key-status-`) preserved, `provider-list` intact; new `key-replace-`/`key-replace-cancel-` added.
- Test (`SettingsPage.test.tsx:161`) asserts: no input while configured, 更换密钥 reveals an **empty** input (`input.value === ''`), the stored key never in `container.innerHTML`, save calls `setProviderKey` with the new key, input hides again, and the new key is also absent from the DOM after save. No key material in the rotation UI state at any point.

### Trivial 1 → RESOLVED
- `keys.ts:69-74` comment now states the store swallows its own read **and decrypt** errors (lost/rotated master key reads as "no key") — accurate given the Minor 1 fix.

### Trivial 2 → AGREED, no code change needed
- Confirmed: the mosga-v04-batch intermingling is commit hygiene for the lead at ship time, not a defect in this change. No source change is warranted and touching those files was out of scope.

**Re-review verdict: ALL FINDINGS RESOLVED — loop clean. No new findings.** Full-suite confidence: fixer reports typecheck clean + 330 passed / 1 skipped; the 4 affected suites re-ran green here (28 tests). The single skip remains the POSIX-only `0600` test gated off on Windows.
