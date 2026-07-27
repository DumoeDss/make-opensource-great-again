## Why

The mosga review UI (`packages/ui`) is hardcoded in Simplified Chinese across ~45 tsx files. To accept contributions from Japanese-, English-, and Korean-speaking donors we need a runtime language switch and locale files — without it the product is single-language by construction. Chinese is the working language of the existing product, so `zh` is both the default and the translation source; targets are `ja`, `en`, `ko`.

## What Changes

- Add **react-i18next** (`i18next` + `react-i18next`) to `@mosga/ui` and a new self-initializing config module `packages/ui/src/lib/i18n.ts` that loads locale resources **synchronously** (bundled JSON imports), so the app renders identically in `zh` with no Suspense/loading flash and component tests need no provider wrapping.
- Introduce `packages/ui/src/locales/{zh,ja,en,ko}.json`. `zh.json` is the **extracted source of truth** for every visible string today; `ja/en/ko.json` are **key-structure stubs** whose values are the `zh` source string as a placeholder. (Actual translation of `ja/en/ko` is **out of scope** for this change — fanned out as parallel per-language subagents immediately after apply, see tasks.md.)
- Wire `useTranslation()` / `t('semantic.nested.key')` across all `packages/ui/src/components/**/*.tsx` + `App.tsx`, replacing only visible zh string literals. className logic, icon imports, and test IDs stay untouched.
- Add a **language switcher** to `SettingsPage.tsx` as a fourth setting, reusing the exact segmented-button control pattern already used by the three-state theme toggle (lines 191–217) — no new control type.
- Persist the choice via a new `packages/ui/src/lib/lang.ts` that mirrors `lib/theme.ts` (`localStorage` key `mosga-lang`, default `'zh'`, best-effort try/catch, jsdom-safe `hasWindow()` guard) and initialize it from `main.tsx` next to `initTheme()`.
- Namespace keys semantically by component/area (e.g. `nav.contribute`, `settings.theme.light`, `stepper.step1`, `stepper.lockPending` with `{{pending}}` interpolation). No string-as-key.
- No **BREAKING** changes: in the default `zh` locale the rendered text is byte-identical to today.

## Capabilities

### New Capabilities

- `ui-i18n`: Runtime internationalization for `@mosga/ui` — react-i18next infrastructure, the four bundled locale files (`zh` source + `ja`/`en`/`ko` stubs), `localStorage` language persistence defaulting to `zh`, and a settings-page language switcher. Covers the whole UI surface; the actual translation of the three non-zh locales is intentionally deferred (stub-only here).

### Modified Capabilities

<!-- None. The language switcher is additive on the settings surface; it does not change any existing ui-journey-shell requirement (theme toggle / daemon status / provider management are untouched). No spec-level requirement elsewhere changes. -->

## Impact

- **Code**: new `packages/ui/src/lib/i18n.ts`, `lib/lang.ts`, `locales/{zh,ja,en,ko}.json`; edits to `main.tsx` (init), `SettingsPage.tsx` (switcher), and ~45 `components/**/*.tsx` + `App.tsx` (string → `t()`).
- **Dependencies**: add `i18next` + `react-i18next` to `packages/ui` `dependencies` (workspace install). No daemon, contracts, or Tauri-shell dependency changes.
- **Tests**: existing `SettingsPage.test.tsx` and other component tests assert on zh substrings (e.g. `toContain('未配置')`); the synchronous-bundle init strategy keeps these green with **zero** test edits. The i18n module is added to the test setup so `useTranslation()` resolves in jsdom.
- **Out of scope**: Tauri shell Rust strings / window titles (`apps/desktop`), daemon log/API responses, RTL (none of zh/ja/en/ko need it), and the actual `ja/en/ko` translation content.
