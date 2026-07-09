## 1. Preset allowlist (direct-submit)

- [x] 1.1 Add `ALLOWED_PRESET_IDS` constant to `packages/direct-submit/src/providers.ts` (`deepseek`, `zhipu`, `zhipu-bigmodel`, `kimi`, `minimax`, `xiaomi-mimo`, `xiaomi-mimo-anthropic`).
- [x] 1.2 Filter `listProviders` to allowlisted presets only (user targets appended unchanged).
- [x] 1.3 Make `resolveProvider` return a preset only when its id is allowlisted; user targets always resolve.
- [x] 1.4 Unit tests: allowlisted preset lists/resolves; a non-allowlisted preset (e.g. `openai`) neither lists nor resolves; a user target still resolves.

## 2. Format conversion: gemini + openai-response (direct-submit)

- [x] 2.1 Extend `apiFormat` handling: replace the anthropic-vs-openai branch in `serializeOutbound` (`submit.ts`) with a four-way switch (`anthropic` / `openai` / `openai-response` / `gemini`).
- [x] 2.2 `openai-response`: build the request from `convertAnthropicRequestToOpenAI(foldThinkingIntoText(request))`, remap `messages`→`input` and `max_tokens`→`max_output_tokens`, target `buildOpenAIResponseApiUrl`.
- [x] 2.3 `gemini`: assemble `contents[]` via `convertMessageToGemini`, fold system into `systemInstruction`, set `generationConfig.maxOutputTokens`, target `buildGeminiApiUrl`.
- [x] 2.4 Extend `authHeaders` (`submit.ts`): `openai-response` uses `Authorization: Bearer`; `gemini` uses `x-goog-api-key`.
- [x] 2.5 Extend `parseUsage` (`transport.ts`) to read Gemini `usageMetadata` (`promptTokenCount` / `candidatesTokenCount`); confirm Responses usage already parses.
- [x] 2.6 Apply the empty-assistant-content guard to the new formats where applicable; ensure `foldThinkingIntoText` runs for all non-anthropic formats.
- [x] 2.7 Unit tests (injected transport, no network): gemini and openai-response produce well-formed bodies to the right URL with the right auth header, thinking is preserved, and usage is parsed; the backstop still scans the serialized body for both formats.

## 3. Port the secret-envelope stack from omnicross (daemon)

- [x] 3.1 Copy `envelope.ts` file-level into `packages/daemon/src/secrets/envelope.ts` (behavior verbatim): AES-256-GCM `enc:v1:<iv>:<tag>:<ciphertext>` codec, fresh 12-byte IV per encrypt, 16-byte tag, secret-free errors. Source: `…/elftia/omnicross/packages/daemon/src/secrets/envelope.ts`.
- [x] 3.2 Copy `masterKey.ts` with renamed constants: env var `MOSGA_MASTER_KEY`, default keyfile `~/.mosga/master.key`. Resolution order env → keyfile → lazy auto-generate `randomBytes(32)` written `0600`; keyfile held separately from the key store.
- [x] 3.3 Copy `SecretBox.ts` (tri-state `encryptMaybe`/`decryptMaybe`, lazy master-key resolver, actionable wrong-key/tampered error). Add a small `secrets/index.ts` barrel.
- [x] 3.4 Unit tests: envelope round-trip; `encryptMaybe`/`decryptMaybe` idempotency and tri-state (`$ENV` passthrough, `enc:` no-nesting, legacy plaintext upgraded on write); master-key resolution order (env beats keyfile, auto-generate last, lazy so a plaintext-only path writes no keyfile); wrong-key/tampered decrypt yields a secret-free error.

## 4. Provider + key persistence store (daemon)

- [x] 4.1 Create `packages/daemon/src/providerStore.ts` behind an injectable interface: load/save `user-providers.json` (array of `UserTarget`) and `provider-keys.json` (`{id:value}` map), atomic write (temp + rename), keys file created `0600`, unreadable files treated as empty.
- [x] 4.2 Route key values through `SecretBox`: `encryptMaybe` on write, `decryptMaybe` on read; construct the box with the lazy master-key resolver so no keyfile is written unless a key is actually encrypted/decrypted.
- [x] 4.3 Custom-provider CRUD in the store (list/create/update/delete) with dedupe-by-id; merge helper that puts `AppOptions.userTargets` first, then persisted providers (injected wins on collision).
- [x] 4.4 Extend `resolveProviderKey` (`packages/direct-submit/src/keys.ts`) to consult the user-scope key store LAST (decrypted via the store's read path): per-provider env → generic env → startup `keyConfigPath` → store.
- [x] 4.5 Unit tests: persistence round-trips; a set plaintext key is stored as an `enc:` envelope and resolves back; injected-first merge; precedence chain (env/startup outrank store); missing/corrupt files read as empty and never throw to a caller.

## 5. Daemon routes (app.ts)

- [x] 5.1 Add zod schemas + routes `GET/POST /api/custom-providers`, `PUT/DELETE /api/custom-providers/:id` (apiFormat enum of the four; `apiBaseUrl` validated as `http(s)`); mutate the store and return key-free records.
- [x] 5.2 Add routes `GET /api/provider-keys` (returns `{id:{configured:boolean}}` only), `PUT /api/provider-keys/:providerId` (set → `encryptMaybe`, no echo), `DELETE /api/provider-keys/:providerId` (clear).
- [x] 5.3 Thread the store into `createApp`: `listProviders`/`resolveProvider` use the merged targets; `resolveProviderKey` uses the store; add `AppOptions` fields + injectable store fake for tests.
- [x] 5.4 Route tests: custom-provider CRUD persists and lists; invalid apiFormat/URL rejected; key set/delete work; no route response, error, or log contains key bytes (plaintext or ciphertext); status returns booleans only.

## 6. CLI + server wiring

- [x] 6.1 Add `--user-providers <path>`, `--provider-keys <path>`, and `--master-key-file <path>` flags to `packages/daemon/src/cli.ts` (defaults under `~/.mosga/`) and help text.
- [x] 6.2 Thread the paths through `server.ts` → `createApp`.

## 7. UI api client + types

- [x] 7.1 Add `types.ts` shapes: custom-provider record, key-status map.
- [x] 7.2 Add `ApiClient` methods: list/create/update/delete custom providers; get key status; set/clear key. Implement in `apiClient` (relative `/api/...`).
- [x] 7.3 Client unit tests for the new calls.

## 8. Settings page UI

- [x] 8.1 Custom-provider section: list allowlisted presets read-only; list custom providers with edit/delete; add form with the four-format `apiFormat` dropdown; wire to client methods.
- [x] 8.2 Key management: per-provider set input + clear button, showing only `configured` status from `GET /api/provider-keys`, never rendering a key value; add a disclosure line that keys are stored encrypted in a local user-scope file.
- [x] 8.3 Preserve existing `data-testid="provider-list"`, theme, and daemon-status contracts; add testids for the new controls.
- [x] 8.4 UI tests (@testing-library/react): add/edit/delete custom provider calls the right routes; setting a key then revisiting shows configured status only and never the key value.

## 9. Full verification

- [x] 9.1 Run `npx vitest run --testTimeout=20000` from the repo root; keep all pre-existing tests green plus the new ones.
- [x] 9.2 Manually verify 出口② end-to-end: add/select a provider, set a key via settings, run estimate + double-consent submit through a fake/real target, confirm the receipt is key-free and `provider-keys.json` holds only an `enc:` envelope. (Automated as an integration test in `packages/daemon/src/__tests__/submit.test.ts` — set key over HTTP → estimate → double-consent submit → key-free receipt + `enc:v1:` envelope on disk.)
- [x] 9.3 Run `node "…/rasen.js" validate settings-provider-management --strict` and confirm it passes.
