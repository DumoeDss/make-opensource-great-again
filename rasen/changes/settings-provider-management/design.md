## Context

出口② direct-submit is fully implemented (submit/estimate/backstop/consent/reconstruct) but unreachable for a normal user: there is no HTTP path to configure an API key (keys resolve only from env or a startup `providerKeyConfigPath`, and `packages/daemon/src/cli.ts` exposes no flag for either), and the 设置 page (`SettingsPage.tsx`) is a read-only list. Meanwhile `/api/providers` returns all 29 `@omnicross/contracts` presets, including vendors the product deliberately excludes.

Current constraints inherited from v0.x (all verified in the codebase):
- The daemon binds loopback only, has no auth, and guards against DNS rebinding with a strict Host allowlist (`isLoopbackHost` in `app.ts`). Threat model = single local user.
- Established discipline: trusted paths (`customRulesPath`, `providerKeyConfigPath`, `dataRepoPath`) are startup-config only, NEVER writable or echoable over HTTP. Keys never appear in any response, log, receipt, or meta message.
- `@omnicross/core` (already a dependency) exports `convertAnthropicRequestToOpenAI` (full request), plus message-level `convertMessageToGemini` / `convertMessageToOpenAI` and URL builders `buildGeminiApiUrl` / `buildOpenAIResponseApiUrl`. There is **no** full Anthropic→Gemini or Anthropic→Responses *request* converter.
- `transport.ts` `parseUsage` recognizes only Anthropic (`input_tokens`) and OpenAI (`prompt_tokens`) usage shapes.
- Frozen: SubmitPanel semantics, all `data-testid` / gate-copy test contracts, and the 219 green tests. Tests inject `submitTransport` fakes and `userTargets`.

## Goals / Non-Goals

**Goals:**
- Make 出口② completable end-to-end for a normal user: narrowed provider list, custom providers, and UI key entry.
- Narrow presets to the 6 open-model source vendors, enforced consistently in list AND resolve.
- Support custom providers across all four named apiFormats (openai / openai-response / anthropic / gemini).
- Introduce an HTTP-writable key path with an explicit, documented threat-model relaxation and no key-echo anywhere.

**Non-Goals:**
- No change to SubmitPanel submit semantics (estimate, double consent, contentHash binding) or the pre-send backstop.
- Keys are encrypted at rest via a ported SecretBox (AES-256-GCM), but this defends against accidental disclosure only, NOT a same-user local attacker (D2). No OS keychain / external secret-vault integration this slice; no envelope version beyond `v1`; no key rotation command.
- No relay/non-open-source presets, no per-request custom-rules or arbitrary file paths.
- No streaming support (ingestion discards the completion body as today).

## Decisions

### D1 — Preset allowlist as a direct-submit constant, enforced in list AND resolve (answers Q2)

Add `ALLOWED_PRESET_IDS` to `packages/direct-submit/src/providers.ts`: `deepseek`, `zhipu`, `zhipu-bigmodel`, `kimi`, `minimax`, `xiaomi-mimo`, `xiaomi-mimo-anthropic`. `listProviders` maps only allowlisted presets; `resolveProvider` returns a preset only if its id is allowlisted (user targets always resolve). Enforcing in `resolveProvider` closes the consistency gap — otherwise the UI hides a preset while `/api/reviews/:id/submit` still accepts it.

**Q2 answer — collect BOTH `xiaomi-mimo` (openai) and `xiaomi-mimo-anthropic` (anthropic).** They are the same vendor's two official open-model endpoints; including both maximizes format coverage at zero added risk and lets the user pick the endpoint their key targets. So the allowlist is 7 preset ids covering 6 vendors. `minimax` is anthropic-only (`https://api.minimaxi.com/anthropic`) — confirmed no issue, the anthropic path already works.

*Alternative considered:* filtering in `@omnicross/contracts` — rejected, the package is a read-only dependency (never fork/patch node_modules).

### D2 — HTTP key path is write-only, encrypted at rest via a ported SecretBox, lowest precedence (answers Q1)

**Q1 answer — ADOPT UI key entry.** Without it the flow cannot complete; env-only is not viable for a normal user. Rather than a plaintext file, keys are **encrypted at rest** by porting omnicross's small secret-envelope stack file-level into the mosga daemon (consistent with the v03 "file-level port from omnicross, don't reinvent" precedent). The omnicross secrets modules (`envelope.ts` / `masterKey.ts` / `SecretBox.ts`, MIT, same author) are NOT exported by the `@omnicross/core` / `@omnicross/contracts` npm packages, and pulling in `@omnicross/daemon` wholesale is not acceptable — so we copy the three modules into `packages/daemon/src/secrets/` with renamed constants.

Design:
- **Ported crypto** (verbatim behavior, renamed constants): `packages/daemon/src/secrets/{envelope.ts,masterKey.ts,SecretBox.ts}`. Envelope format is `enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>` — AES-256-GCM, fresh 12-byte IV per encrypt, 16-byte auth tag; a wrong key or tampered value fails GCM verification and maps to an actionable, secret-free error. `SecretBox.encryptMaybe`/`decryptMaybe` apply the idempotent tri-state discrimination: `$`-prefix = env indirection (always plaintext passthrough), `enc:` = ciphertext (decrypt on read, passthrough on write — no `enc:enc:` nesting), legacy plaintext (passthrough on read, upgraded to `enc:` on write).
- **Master-key chain** (renamed from omnicross): `MOSGA_MASTER_KEY` env (64 hex or base64→32 bytes, never written to disk) → keyfile `~/.mosga/master.key` (0600, deliberately NOT a sibling of the provider-keys/config files so a copied config never drags the key) → lazy auto-generate `randomBytes(32)` on first crypto use. The key is resolved lazily (a pure legacy-plaintext/`$ENV` passthrough never triggers a keyfile write).
- **Store file** `~/.mosga/provider-keys.json` keeps its shape `{ providerId: value }`, but every value is run through `SecretBox`: `encryptMaybe` on write (a UI-entered key is always stored as an `enc:` envelope), `decryptMaybe` on read (so a hand-authored `$ENV` indirection or a legacy plaintext value still resolves, and is upgraded to ciphertext next time it is written). File created `0600`; atomic write (temp + rename).
- Routes: `PUT /api/provider-keys/:providerId` (body `{ apiKey }`, write → `encryptMaybe`), `DELETE /api/provider-keys/:providerId` (clear), `GET /api/provider-keys` (status map `{ providerId: { configured: boolean } }`). No route ever returns key bytes, plaintext or ciphertext.
- Extend `resolveProviderKey` (`keys.ts`) with the store as the LAST precedence tier: per-provider env → generic env → startup `keyConfigPath` → user-scope store (read via `decryptMaybe`). Explicit server config always outranks a UI-written key — preserving the existing invariant and keeping operator intent authoritative.
- The store path and keyfile path are server-derived (homeDir + fixed name), never client-supplied — the arbitrary-file-read discipline is intact.

**Threat-model change (the central decision, documented for the gate):** this is the daemon's first HTTP-writable secret. Prior discipline forbade it; we relax it for keys specifically. Mitigations that make this acceptable under the existing single-user loopback threat model: (1) loopback-only bind + Host allowlist already block cross-origin/DNS-rebinding drive-by writes; (2) write-only + status-only-boolean means a successful attacker still cannot exfiltrate a key via the API; (3) encryption at rest keeps key bytes out of the JSON file, so an accidentally-shared/backed-up/secret-scanned `provider-keys.json` reveals only ciphertext; (4) the keyfile lives in a separate 0600 file that a copied config never drags along. **Honest caveat (same as omnicross's design D8):** `master.key` is co-resident with the ciphertext on the same machine, so this defends against *accidental disclosure* (backups, config sharing, secret scanners) — NOT against a local attacker running as the user, who can read both the keyfile and decrypt. On Windows `chmod 0600` is best-effort (NTFS ACLs don't map POSIX mode); the write still succeeds and the caveat is documented for the user. This is the same exposure class omnicross accepts and strictly better than the pre-existing plaintext `providerKeyConfigPath`.

*Alternatives considered:* (a) keep env-only — rejected, flow stays broken; (b) plaintext JSON file — rejected on user feedback, needlessly exposes keys to backups/scanners when a proven encrypted port exists; (c) depend on `@omnicross/daemon` for SecretBox — rejected, those modules aren't published and a wholesale daemon dependency is too heavy; (d) rank the UI file first in precedence — rejected, would let an HTTP write silently override explicit operator env config.

### D3 — Custom providers: user-scope JSON + zod CRUD, merged with injected targets (answers Q4)

**Q4 answer.** File `~/.mosga/user-providers.json` = an array of `UserTarget` (`id/name/apiFormat/apiBaseUrl/models`, never a key). Loaded at startup into an in-memory cache; CRUD routes mutate cache + rewrite the file. Merge with `AppOptions.userTargets`: **injected targets first, then file-persisted, deduped by id with injected winning** — keeps daemon tests (which inject `userTargets`) deterministic and unaffected. Routes: `GET/POST /api/custom-providers`, `PUT/DELETE /api/custom-providers/:id`, all zod-validated (`apiFormat` enum of the four; `apiBaseUrl` parsed as `http(s)` URL). Custom providers bypass the preset allowlist by construction — they are the user's own explicit targets, resolved via the userTargets branch of `resolveProvider`.

New daemon module `packages/daemon/src/providerStore.ts` owns both files (providers + keys) behind a small injectable interface, mirroring how `publish.ts` isolates its concern; `createApp` wires it and tests can inject an in-memory fake instead of touching disk.

### D4 — gemini / openai-response conversion: reuse omnicross, thin envelope adapter where none exists (answers Q3)

**Q3 answer — reuse `@omnicross/core` where a converter exists; write a minimal in-repo request-envelope adapter where it does not.** Concretely, extend `serializeOutbound` / `authHeaders` in `submit.ts` from an anthropic-vs-openai branch to a four-way switch on `apiFormat`:
- `anthropic`: native (unchanged) — `x-api-key` + `anthropic-version`.
- `openai`: `convertAnthropicRequestToOpenAI(foldThinkingIntoText(request))` (unchanged) — `Authorization: Bearer`.
- `openai-response`: build a Responses-API request from the OpenAI chat-completions conversion — reuse `convertAnthropicRequestToOpenAI`, remap `messages`→`input` and `max_tokens`→`max_output_tokens`, POST to `buildOpenAIResponseApiUrl(...)`. Auth `Authorization: Bearer`. Responses usage is already `input_tokens`/`output_tokens` — **parseUsage needs no change** for it.
- `gemini`: assemble `contents[]` via `convertMessageToGemini` per message, fold system turns into `systemInstruction`, set `generationConfig.maxOutputTokens`, POST to `buildGeminiApiUrl(...)`. Auth via `x-goog-api-key` header. **parseUsage must be extended** to read Gemini's `usageMetadata` (`promptTokenCount` / `candidatesTokenCount`).

The `foldThinkingIntoText` guard applies to every non-anthropic format (thinking blocks would otherwise be dropped and can yield null-content turns). The pre-send backstop still scans the exact serialized body for every format — invariant preserved, since the backstop runs on `body` regardless of shape.

*Why not砍 (drop) gemini/openai-response:* the user named all four formats verbatim; reuse cost is low because message-level converters and URL builders already exist and only a thin envelope + one usage branch are new. *Alternative considered:* hand-rolling full message conversion — rejected, it would reinvent `convertMessageToGemini` and drift from omnicross semantics.

### D5 — CLI flags + AppOptions wiring

Add `--user-providers <path>` and `--provider-keys <path>` overrides to `cli.ts` (default to `~/.mosga/...`), threaded through `server.ts` → `createApp` as store overrides, alongside the existing `--data-repo`. This keeps the store path server-derived and testable.

### D6 — UI settings surface

`SettingsPage.tsx` gains: a custom-provider section (list with edit/delete + an add form with the four-format dropdown, wired to new `client` methods), and per-provider key controls (set input + clear button, showing only `configured` status from `GET /api/provider-keys`, with a plaintext-storage disclosure line). New `ApiClient` methods and `types.ts` shapes for custom-provider CRUD and key status. Existing `data-testid="provider-list"` and theme/daemon test contracts stay; new controls get their own testids. No key value is ever placed in the DOM.

## Risks / Trade-offs

- **[First HTTP-writable secret path]** → write-only API, status-only boolean, loopback + Host allowlist, AES-256-GCM encryption at rest via ported SecretBox, 0600 keyfile held separately from the ciphertext; precedence keeps explicit server config authoritative (D2). Residual risk: a same-user local attacker can read the keyfile and decrypt — documented honestly, unchanged from omnicross.
- **[Ported crypto could drift from omnicross semantics]** → copy the three modules file-level with behavior verbatim (only constants renamed), and add unit tests over the envelope round-trip, tri-state idempotency (`encryptMaybe`/`decryptMaybe`), master-key resolution order, and the wrong-key/tampered auth-failure path.
- **[gemini/openai-response conversion is new and untested against real endpoints]** → reuse omnicross message converters; add unit tests over the serialized body via injected transport (no real network); the backstop still scans every format's bytes. If a real endpoint rejects the shape it surfaces as a provider-status error, never a silent malformed send (existing empty-assistant guard pattern extended).
- **[Narrowing `/api/providers` is behaviorally breaking]** → intended; any previously-selectable non-allowlisted preset now 404s at resolve. Acceptable — those were never intended targets.
- **[User-scope file corruption / concurrent writes]** → single-user single-daemon; treat unreadable file as empty (same tolerance as `resolveProviderKey`'s try/catch), write atomically (temp + rename) to avoid truncation.
- **[Custom apiBaseUrl is user-controlled outbound target]** → acceptable under single-user threat model; zod validates `http(s)` shape only (no SSRF hardening — the user is targeting their own chosen provider).

## Migration Plan

Additive and backward-compatible for existing deployments: env / `providerKeyConfigPath` / injected `userTargets` continue to work unchanged (higher or equal precedence). No data migration — the user-scope files are created on first write and absent files read as empty. Rollback = revert the change; the new files are ignored by the prior code. The only user-visible behavioral shift is the shrunk provider list, which is the intended outcome.

## Open Questions

All four seeded open questions are resolved above (Q1 → D2 adopt write-only; Q2 → D1 both MiMo presets; Q3 → D4 reuse + thin adapter; Q4 → D3 file + injected-first merge). No blocking unknowns remain for implementation. One deferred item for a later slice: whether key status should also report *which* source satisfied it (env vs store) as a non-sensitive UX hint — not required for this change and omitted to keep the status contract to `configured: boolean`.
