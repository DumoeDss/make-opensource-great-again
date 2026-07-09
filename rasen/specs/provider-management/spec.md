# provider-management Specification

## Purpose
TBD - created by archiving change settings-provider-management. Update Purpose after archive.
## Requirements
### Requirement: Custom provider persistence and CRUD over HTTP

The daemon SHALL persist user-added custom provider targets in a user-scope JSON file (default `~/.mosga/user-providers.json`) and SHALL expose zod-validated routes to list, create, update, and delete them. A custom provider record SHALL carry `id`, `name`, `apiFormat`, `apiBaseUrl`, and `models`, and SHALL NEVER carry API-key material. `apiFormat` SHALL be one of `openai`, `openai-response`, `anthropic`, or `gemini`; `apiBaseUrl` SHALL be validated to be an `http(s)` URL. On startup the daemon SHALL load the persisted custom providers and merge them with any `AppOptions.userTargets` (test-injected / startup-configured), with the injected targets taking precedence on id collision so tests remain deterministic. The custom providers SHALL be exposed through the same key-free provider list the presets use, and SHALL always be resolvable regardless of the preset allowlist.

#### Scenario: Custom provider is created and persisted

- **WHEN** a valid custom provider is POSTed to the custom-provider route
- **THEN** it is written to the user-scope file and appears in the provider list on the next read

#### Scenario: Invalid apiFormat or URL is rejected

- **WHEN** a custom provider is submitted with an `apiFormat` outside the four allowed values or an `apiBaseUrl` that is not an `http(s)` URL
- **THEN** the route rejects it with a validation error and nothing is persisted

#### Scenario: Custom provider is updated and deleted

- **WHEN** an existing custom provider is updated, then deleted, via its route
- **THEN** the change is written to the user-scope file and reflected in the provider list, and the deleted provider no longer resolves

#### Scenario: A custom provider record never carries a key

- **WHEN** custom providers are persisted or returned by any route
- **THEN** the stored and returned records contain only id/name/apiFormat/apiBaseUrl/models and no key field

### Requirement: Write-only provider API-key management over HTTP with encryption at rest

The daemon SHALL allow a provider API key to be SET and DELETED over HTTP but NEVER read back. A set route SHALL accept a key for a provider id and persist it to a user-scope key store (default `~/.mosga/provider-keys.json`, created with owner-only `0600` permissions). Stored key values SHALL be **encrypted at rest** as AES-256-GCM envelope strings (`enc:v1:<iv>:<tag>:<ciphertext>`): a value written through the store SHALL be encrypted unless it is already an envelope or a `$`-prefixed environment-indirection reference (which SHALL pass through as plaintext), and a value read from the store SHALL be decrypted when it is an envelope and passed through otherwise (so a hand-authored `$ENV` reference or a legacy plaintext value still resolves). The encryption master key SHALL be resolved as: `MOSGA_MASTER_KEY` env → keyfile `~/.mosga/master.key` (owner-only `0600`, held separately from the key store so a copied store never carries the master key) → lazily auto-generated 32 random bytes on first cryptographic use. A wrong or tampered value SHALL fail decryption with an actionable, secret-free error and SHALL NOT be echoed. A delete route SHALL remove a provider's key. A status route SHALL return, per provider, only whether a key is `configured` (a boolean) — it SHALL NEVER return, echo, or partially reveal any key bytes (plaintext or ciphertext), in this or any other response, log line, or receipt. Key resolution precedence SHALL preserve the existing order and place the HTTP-written store LAST: per-provider env (`MOSGA_PROVIDER_KEY_<ID>`) → generic env (`MOSGA_PROVIDER_KEY`) → trusted startup `providerKeyConfigPath` file → user-scope key store. The key SHALL be used only as the outbound authorization header at send time.

#### Scenario: Setting a key never echoes it

- **WHEN** a key is set for a provider over HTTP
- **THEN** the response confirms success without returning any key bytes, and the key is persisted to the owner-only user-scope file

#### Scenario: Stored key value is encrypted at rest

- **WHEN** a plaintext key is set for a provider over HTTP
- **THEN** the value written to the key store is an `enc:v1:` AES-256-GCM envelope, not the raw key, and decrypting it with the resolved master key yields the original key

#### Scenario: Environment-indirection and legacy plaintext values still resolve

- **WHEN** the store holds a `$`-prefixed env-indirection reference or a legacy plaintext value
- **THEN** the reference/plaintext passes through on read unchanged, and a legacy plaintext value is upgraded to an encrypted envelope the next time it is written

#### Scenario: Key status reports configured boolean only

- **WHEN** the key-status route is queried
- **THEN** it returns per-provider `configured: boolean` and no key material of any kind

#### Scenario: Deleting a key clears it

- **WHEN** a provider's key is deleted over HTTP
- **THEN** the entry is removed from the user-scope store and the provider's status becomes `configured: false`

#### Scenario: Explicit server config outranks the HTTP-written key

- **WHEN** both an environment variable (or startup key-config file) and a UI-written key exist for the same provider
- **THEN** the environment / startup-config key is used, preserving the existing precedence

