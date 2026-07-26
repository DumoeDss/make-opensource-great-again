# ui-i18n Specification

## Purpose
TBD - created by archiving change mosga-v05-i18n. Update Purpose after archive.
## Requirements
### Requirement: Default language is Chinese with bundled synchronous locales

`@mosga/ui` SHALL initialize react-i18next at module-load time with four bundled locale resources — `zh`, `ja`, `en`, `ko` — imported as static JSON (no HTTP backend, no async loading, no Suspense boundary). The default language SHALL be `zh`, and the `zh` resources SHALL be the translation source of truth. Any unsupported or missing language value SHALL fall back to `zh`.

#### Scenario: First render is zh with no loading flash

- **WHEN** the app loads with no prior language choice in `localStorage`
- **THEN** every translated surface renders the `zh` string on first paint, with no Suspense fallback, no empty-text flash, and no async gap

#### Scenario: Unknown stored value falls back to zh

- **WHEN** `localStorage['mosga-lang']` holds a value not in the supported set (e.g. `xx`)
- **THEN** the UI initializes in `zh` and treats `zh` as the active language for the session

### Requirement: Language choice persists in localStorage mirroring the theme module

The chosen language SHALL persist under `localStorage` key `mosga-lang`, using the same best-effort, jsdom-safe pattern as `lib/theme.ts`: a `hasWindow()` guard around all storage access, silent try/catch around both get and set, and validation of the stored value against the supported-language whitelist before applying. On startup the saved language SHALL be applied before first render via an `initLanguage()` call from `main.tsx`; the default SHALL be `zh` when the key is unset or unreadable.

#### Scenario: Choice survives reload

- **WHEN** the user selects `ja` in the settings picker, then reloads the page
- **THEN** the UI renders in `ja` on the reloaded page without any further user interaction

#### Scenario: Persistence failures are silent

- **WHEN** `localStorage` is unavailable or denies access (private mode, disabled storage, quota)
- **THEN** the choice is applied for the current session only, no error is surfaced to the user, and the UI still renders correctly

### Requirement: Language switcher reuses the segmented control pattern

The settings page SHALL expose a language picker that reuses the existing segmented-button control already used by the three-state theme toggle — a `<div className="inline-flex rounded-md border border-border bg-surface-1 p-1">` shell containing per-option `<button>`s styled with `cn(...)` for active vs muted states — and SHALL NOT introduce a new control type. The picker SHALL offer exactly four options shown as endonyms: `中文`, `日本語`, `English`, `한국어` (the active language pressed). Selecting an option SHALL call `i18n.changeLanguage()` and persist the choice; react-i18next SHALL re-render every translated surface live without a page reload. Option labels SHALL NOT be translated (endonyms stay fixed across all locales) so a user can always locate their language.

#### Scenario: Switching language re-renders the whole UI live

- **WHEN** the user selects `日本語` in the settings language picker
- **THEN** the NavRail, Stepper, SettingsPage headings, provider labels, and all other translated surfaces render the `ja` strings immediately without a reload, and the `日本語` button shows as pressed

#### Scenario: Control matches the theme toggle's pattern

- **WHEN** the language picker is rendered
- **THEN** it uses the same container classes and per-option button structure/styling as the theme toggle on the same page, and exposes `data-testid="lang-toggle"` plus `data-testid="lang-{id}"` per option

### Requirement: Semantic nested keys with interpolation parameters

Translation keys SHALL be semantic, dotted, and nested by component or area (e.g. `nav.contribute`, `settings.theme.light`, `stepper.lockPending`), never the literal source string. Dynamic substrings (counts, daemon name/version, provider id) SHALL be expressed as `{{var}}` interpolation parameters passed to `t()`, not as string concatenation in the component.

#### Scenario: Dynamic counts interpolate

- **WHEN** the lock badge shows `还差 3 项解锁` in `zh`
- **THEN** the underlying key is `stepper.lockPending` rendered as `还差 {{pending}} 项解锁` with `{ pending: 3 }`, and the `ja`/`en`/`ko` locales translate the sentence while preserving the `{{pending}}` placeholder

#### Scenario: Daemon name and version interpolate

- **WHEN** the daemon health line shows `已连接 (mosga-daemon 0.1.0)` in `zh`
- **THEN** the underlying key is `settings.daemon.healthOk` rendered as `已连接 ({{name}} {{version}})` with `{ name, version }`, and every other locale preserves both `{{name}}` and `{{version}}`

### Requirement: zh extraction is the source of truth with no visible regression

Every visible Simplified-Chinese string literal currently hardcoded across `packages/ui/src/**/*.tsx` SHALL be moved into `locales/zh.json` and rendered through `t()`. className logic, icon imports, and `data-testid` attributes SHALL NOT change. When the active language is `zh`, the rendered text SHALL be byte-identical to the pre-i18n app, and every existing component test that asserts on zh substrings SHALL continue to pass without test edits.

#### Scenario: zh strings live only in the locale file

- **WHEN** extraction is complete
- **THEN** no zh CJK literal appears in any `packages/ui/src/**/*.tsx` source file outside of `locales/zh.json`, and `zh.json` contains every previously-hardcoded string under its semantic key

#### Scenario: Test IDs and styling are preserved

- **WHEN** the `useTranslation()` wiring is applied to a component
- **THEN** every `data-testid`, className, and icon import in that component is unchanged, and existing component tests (`SettingsPage.test.tsx` et al.) that assert on zh substrings pass without edits

### Requirement: Non-zh locales start as key-mirror stubs; translation is deferred

The `ja`, `en`, and `ko` locale files SHALL exist with a key structure identical to `zh.json`. Each stub leaf value SHALL equal the `zh` source string for that key (a placeholder), so the app degrades to `zh` text in any not-yet-translated locale. The actual translation content is NOT part of this capability — it is produced by a separate, parallel per-language translation step that overwrites only the leaf values in place, without adding, removing, or renaming any key.

#### Scenario: Stub locale renders the zh string as placeholder

- **WHEN** the user switches to `ko` before any translation pass has run
- **THEN** every translated surface renders the `zh` source string (the placeholder value), the app remains fully functional, and no key is reported missing

#### Scenario: Translation pass only overwrites values

- **WHEN** a downstream translator edits `locales/ja.json` to add real Japanese translations
- **THEN** only the leaf string values change; the key set remains identical to `zh.json`, and `npm run build` / `npm run typecheck -w @mosga/ui` / `vitest run` remain green without any further code edits

