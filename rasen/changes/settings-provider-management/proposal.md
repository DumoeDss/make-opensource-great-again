## Why

The 设置 page is read-only and there is no HTTP path to configure a provider API key, so 出口② direct-submit can never complete end-to-end for a normal user (keys are startup-env only; `--provider-keys` / `--user-targets` flags don't even exist). At the same time the provider picker exposes all 29 `@omnicross/contracts` presets, including non-open-source vendors and relay providers the product deliberately does not target. This change makes settings usable — narrowed preset list, custom providers, and UI key entry — so the direct-submit flow works front to back.

## What Changes

- **Narrow the preset list to exactly the 6 open-source-model source vendors** — DeepSeek, z.ai, 智谱 GLM, Kimi (Moonshot), MiniMax, 小米 MiMo — via an allowlist constant in `@mosga/direct-submit` (7 preset ids: `deepseek`, `zhipu`, `zhipu-bigmodel`, `kimi`, `minimax`, `xiaomi-mimo`, `xiaomi-mimo-anthropic`; MiMo ships two official endpoints). Both `listProviders` and `resolveProvider` filter consistently, so a non-allowlisted preset is neither shown nor submittable. **BREAKING** (behavioral): previously-visible presets disappear from `/api/providers`.
- **Custom provider add/edit/delete** — daemon-side persistence in a user-scope JSON file, zod-validated CRUD routes, and a settings-page form. `apiFormat` is one of `openai` (chat completions) / `openai-response` (Responses API) / `anthropic` / `gemini`.
- **Add gemini and openai-response request conversion** to the submitter (only custom providers use them; the 6 presets are all openai/anthropic). Reuse `@omnicross/core` where a converter exists; write a thin request-envelope adapter where it does not. Extend usage parsing to gemini's `usageMetadata`.
- **Provider API-key management from the settings page** — write-only over HTTP: set and delete only, never echoed. Status is reported as `configured: boolean` per provider, never key bytes. Keys persist **encrypted at rest** (AES-256-GCM) in a user-scope file, using a secret-envelope stack ported file-level from omnicross (`MOSGA_MASTER_KEY` env → `~/.mosga/master.key` → lazy auto-generate); the existing env / startup `providerKeyConfigPath` precedence is preserved. This **relaxes** the prior "keys are startup-config only, never HTTP-writable" discipline; the threat-model change is documented in design.md.
- **Settings page becomes interactive** — the read-only provider list gains custom-provider CRUD and per-provider key set/clear controls, without ever displaying key material.

Unchanged: SubmitPanel semantics (cost estimate, double informed-consent, consent bound to `contentHash`), the pre-send raw-bytes backstop, all frozen `data-testid`/gate-copy test contracts, and the invariant that no key appears in any daemon response, log, receipt, or meta message.

## Capabilities

### New Capabilities
- `provider-management`: Daemon-side management surface for provider targets and keys — user-scope persistence of custom providers, zod-validated CRUD routes, and write-only API-key set/delete/status routes that never echo key bytes.

### Modified Capabilities
- `direct-submit`: Provider targeting narrows to the open-model source-vendor allowlist (both list and resolve); request reconstruction gains gemini and openai-response format conversion plus gemini usage parsing.
- `ui-journey-shell`: The settings page changes from a read-only provider list to an interactive surface that manages custom providers and provider keys (keys never displayed).

## Impact

- **Code**: `packages/direct-submit/src/{providers,keys,reconstruct,transport,submit}.ts`; `packages/daemon/src/{app.ts,cli.ts,server.ts}` (new routes, new `--user-providers`/`--provider-keys` wiring, AppOptions); a new daemon persistence module for user-scope provider/key files; `packages/ui/src/components/SettingsPage.tsx` and `packages/ui/src/api/{client,types}.ts`.
- **APIs**: new `GET/POST/PUT/DELETE /api/custom-providers`; new `GET /api/provider-keys` (status only) + `PUT/DELETE /api/provider-keys/:providerId`. `/api/providers` payload shrinks to the allowlist.
- **Dependencies**: reuse existing `@omnicross/core` converters and `@omnicross/contracts` presets (read-only, no fork). No new npm dependency.
- **Security**: introduces the first HTTP-writable secret path in the daemon; mitigated by loopback-only bind + Host allowlist (existing DNS-rebinding guard), write-only semantics, AES-256-GCM encryption at rest via a ported SecretBox (master key held in a separate 0600 keyfile), and an at-rest-encryption disclosure in the UI. Ports omnicross's `secrets/{envelope,masterKey,SecretBox}` file-level (not published on npm; no `@omnicross/daemon` dependency). Documented in design.md.
- **Tests**: root `npx vitest run --testTimeout=20000` (219 green today) must stay green; daemon tests inject fakes; new persistence/route/UI tests added.
