## MODIFIED Requirements

### Requirement: Settings page with three-state theme toggle and daemon status

The 设置 page SHALL provide a three-state theme toggle (light / dark / system) that drives the `.dark` class and persists the choice, replacing the follow-system-only bootstrap; the `system` option SHALL track `prefers-color-scheme`. It SHALL also show the daemon address + health and the list of targetable provider targets from the providers endpoint. The allowlisted vendor **presets** SHALL be shown without an edit control (they are fixed source-vendor targets). The page SHALL additionally let the user **add, edit, and delete custom providers** (name, `apiBaseUrl`, `models`, and an `apiFormat` chosen from openai / openai-response / anthropic / gemini) and **set or clear a provider API key** for a targetable provider. Key entry SHALL be write-only: the page SHALL show only a `configured` / `not configured` status per provider and SHALL NEVER display, prefill, or echo any stored key bytes, and SHALL disclose that a submitted key is stored encrypted at rest in a local user-scope file. The data-repository path remains startup-config only and out of scope for editing here.

#### Scenario: Theme toggle switches and persists

- **WHEN** the user selects `dark`, then reloads
- **THEN** the `.dark` class is applied and the dark choice persists across reload

#### Scenario: System option follows the OS preference

- **WHEN** the user selects `system`
- **THEN** the theme tracks `prefers-color-scheme` and updates live when the OS preference changes

#### Scenario: Provider targets shown read-only

- **WHEN** the settings page loads
- **THEN** it lists the targetable provider targets from the providers endpoint without exposing any key material, and the vendor presets are shown without an edit control

#### Scenario: Custom provider can be added, edited, and removed

- **WHEN** the user adds a custom provider with an apiFormat chosen from the four supported formats, then edits and deletes it
- **THEN** each change calls the corresponding custom-provider route and the settings list updates to reflect it

#### Scenario: Key entry is write-only and never echoed

- **WHEN** the user sets a key for a provider and later revisits the settings page
- **THEN** the page shows only a configured status for that provider, never the key value, and offers set/clear actions with an at-rest-encryption storage disclosure
