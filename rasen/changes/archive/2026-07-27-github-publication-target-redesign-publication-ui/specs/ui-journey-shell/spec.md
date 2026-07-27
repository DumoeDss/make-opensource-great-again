## ADDED Requirements

### Requirement: Publication surfaces are responsive and accessible

The Settings target panel, publication status card, preview, public confirmation, errors, and receipt SHALL reuse the existing semantic tokens and component primitives. They SHALL remain usable at narrow and desktop widths, expose programmatic labels and status/error announcements, retain visible keyboard focus, and SHALL NOT communicate readiness or risk by color alone.

#### Scenario: Narrow target and preview layout remains readable

- **WHEN** Settings or the publication wizard is rendered at a narrow viewport
- **THEN** controls stack, long repository/hash values wrap, file commitments scroll within their container, and no action or meaning is clipped

#### Scenario: Keyboard can complete safe publication

- **WHEN** a keyboard user saves a target, starts preview, reviews the result, opens the public confirmation, and confirms or cancels
- **THEN** every control is reachable in logical order, focus remains visible, and the dialog traps/restores focus through the existing accessible primitive

#### Scenario: Async and error state is announced

- **WHEN** status, configure, preview, or submit enters progress, success, or error
- **THEN** visible text and appropriate live/alert semantics communicate the change independently of color or icon

## MODIFIED Requirements

### Requirement: Dual exit cards with secondary export and receipt completion

The exit step SHALL present two equal exit cards. Exit ① public dataset contribution SHALL consume the daemon's GitHub publication status and open the shared preview-to-confirmed-submit wizard when ready or fork confirmation is required. Exit ② API direct submit SHALL preserve every existing target/model/mode, estimate, acknowledgment, submission, and receipt semantic. The low-key sanitized-file-only export SHALL remain available. Either successful exit SHALL set the existing completion badge; successful exit ① SHALL keep its real GitHub PR receipt visible within the wizard rather than adding another journey step.

#### Scenario: Both exits remain equal

- **WHEN** the exit step is reached
- **THEN** the public GitHub contribution and API direct-submit cards are shown as equals with sanitized-file export as a low-key secondary action

#### Scenario: Exit-one status controls only exit one

- **WHEN** GitHub publication is not currently usable
- **THEN** exit ① shows status-specific recovery and is disabled while exit ② and gate-allowed sanitized export remain available

#### Scenario: GitHub receipt completes the journey

- **WHEN** exit ① returns a real publication receipt
- **THEN** the receipt remains visible and the existing journey badge becomes completed without adding a fourth interactive step

#### Scenario: Direct-submit receipt remains unchanged

- **WHEN** exit ② succeeds
- **THEN** its existing receipt summary and completion behavior remain unchanged by the publication redesign

### Requirement: Settings page with three-state theme toggle and daemon status

The Settings page SHALL preserve the light/dark/system theme toggle, daemon address/health, provider target management, and write-only provider-key behavior. It SHALL replace the read-only local data-repository block with one editable GitHub publication target. The target panel SHALL let the user enter canonical `owner/repo`, save/validate it, refresh readiness, and clear it. It SHALL render the exact daemon status plus available actor, canonical upstream, default branch/base, direct-or-fork push route/repository, target revision, compatibility contract/schemas/license, and curated issues, while never showing `TargetSummary.url`, a local path, token, remote URL/name, command, or raw external error.

#### Scenario: Theme toggle switches and persists

- **WHEN** the user selects `dark`, then reloads
- **THEN** the `.dark` class is applied and the dark choice persists across reload

#### Scenario: System option follows the OS preference

- **WHEN** the user selects `system`
- **THEN** the theme tracks `prefers-color-scheme` and updates live when the OS preference changes

#### Scenario: Provider targets shown read-only

- **WHEN** the settings page loads
- **THEN** it lists the targetable provider targets without exposing key material, and vendor presets have no edit control

#### Scenario: Custom provider can be added, edited, and removed

- **WHEN** the user adds a custom provider with one of the four supported API formats, then edits and deletes it
- **THEN** each change calls the existing custom-provider route and the settings list updates

#### Scenario: Key entry is write-only and never echoed

- **WHEN** the user sets a provider key and later revisits Settings
- **THEN** the page shows only configured/not-configured status, never the key value, and retains set/clear actions plus the at-rest-encryption disclosure

#### Scenario: Canonical target can be configured

- **WHEN** the user enters a valid canonical `owner/repo` and saves
- **THEN** Settings sends only `{ repository }`, replaces the panel with the returned status/revision, and displays any ready, login, fork-confirmation, or blocked result without treating HTTP success as readiness

#### Scenario: Invalid target remains editable

- **WHEN** target configuration returns `invalid_target`
- **THEN** the input remains available with the curated validation message and no local normalization, URL conversion, or extra authority field is submitted

#### Scenario: Target status can be refreshed

- **WHEN** the user requests a readiness refresh
- **THEN** Settings calls `GET /api/publish` and replaces all displayed target facts with the returned server state

#### Scenario: Target clear is explicit and local

- **WHEN** the user confirms Clear target
- **THEN** Settings sends `DELETE /api/publish/target` with JSON content type and no body, displays the returned newer unconfigured revision, and explains that existing remote forks, branches, and PRs are not deleted

#### Scenario: Blocked target summary is optional

- **WHEN** a blocked status omits `target`
- **THEN** Settings shows only curated issues and an unavailable-details state, permits re-entry or clear, and does not promote its draft or prior target to configured truth

#### Scenario: Legacy data-repository guidance is absent

- **WHEN** Settings is inspected after the replacement
- **THEN** it has no read-only data-repository status, `--data-repo` restart instruction, local-clone path, workspace control, or manual Git/`gh` guidance

### Requirement: Raw JSON demoted to advanced folds

No raw JSON SHALL be the primary information carrier in the review UI. Sanitized export and direct-submit receipt behavior SHALL remain human-summary-first with raw JSON only in an Advanced fold. GitHub publication preview and receipt SHALL use purpose-built target, PR, file-commitment, and audit summaries; they SHALL never render a generic raw preview/error object or exact contribution contents. Engine pins MAY use an Advanced fold.

#### Scenario: Export preview leads with a summary

- **WHEN** a sanitized export is previewed
- **THEN** a human-readable summary is primary and raw session JSON remains inside a collapsed Advanced fold

#### Scenario: Direct-submit receipt leads with a summary

- **WHEN** an exit ② receipt is shown
- **THEN** key fields remain summarized as a card and raw receipt JSON remains inside a collapsed Advanced fold

#### Scenario: Publication preview is purpose-built

- **WHEN** a GitHub publication preview is shown
- **THEN** target, PR, file commitment, digest, and expiry fields are rendered through labeled summaries rather than `JSON.stringify`

#### Scenario: Publication receipt is safe by construction

- **WHEN** a GitHub publication receipt is shown
- **THEN** its audited public fields are rendered directly and no exact file contents, workspace, token, command, raw output, or arbitrary raw error object is available in the primary or advanced UI
