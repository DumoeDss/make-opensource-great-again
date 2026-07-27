# Implementation Tasks — mosga-v05-i18n

> **SCOPE BOUNDARY (enforced by LEAD):** This change ONLY builds i18n infrastructure, extracts zh strings into `locales/zh.json`, wires `useTranslation`/`t()`, adds the language switcher + persistence, and creates **key-mirror stub** locale files for `ja`/`en`/`ko` (each leaf value = the zh source string).
>
> **DO NOT translate** any ja/en/ko content. Translation is a separate LEAD-orchestrated parallel fan-out that runs AFTER apply. Stub values staying equal to the zh source is correct and expected.
>
> **Preserve everything non-textual:** className logic, icon imports, `data-testid` attributes, and control flow are untouched — only swap visible zh literals for `t('key')`. The default-zh render MUST be byte-identical to today, and every existing UI test MUST pass without edits.

## 1. Dependencies & i18n scaffolding

- [x] 1.1 Add `i18next` and `react-i18next` to `packages/ui` `dependencies` via workspace install (e.g. `npm i -w @mosga/ui i18next react-i18next`). Confirm both appear in `packages/ui/package.json` `dependencies` and the install resolves against the root lockfile.
- [x] 1.2 Create the locale directory `packages/ui/src/locales/` and an empty `zh.json` (`{}`) — filled progressively in §2.
- [x] 1.3 Create `packages/ui/src/lib/i18n.ts`: a self-initializing module that imports the four locale JSONs as static Vite assets and runs `i18next.use(initReactI18next).init({ resources, lng: 'zh', fallbackLng: 'zh', interpolation: { escapeValue: false }, returnEmptyString: false, react: { useSuspense: false } })` at module-evaluation time. Export the bound `i18n` instance and a `LANGUAGES` constant (`['zh','ja','en','ko']`). No HTTP backend, no Suspense.
- [x] 1.4 Create `packages/ui/src/lib/lang.ts` mirroring `lib/theme.ts`: `STORAGE_KEY = 'mosga-lang'`, `hasWindow()` guard, silent try/catch around all `localStorage` get/set, whitelist validation against `LANGUAGES`, default `'zh'`. Exports `getLanguage()`, `setLanguage(lang)` (persists then calls `i18n.changeLanguage(lang)`), `initLanguage()` (reads stored, validates, applies). NO subscriber Set — react-i18next re-renders on `i18n.changeLanguage` automatically.
- [x] 1.5 Locate the vitest `setupFiles` entry (read root `vitest.config.ts`). Add a side-effect `import './lib/i18n'` (path-relative as the setup file requires) so every jsdom test gets a initialized default i18n instance. If no setup file exists, create `packages/ui/src/test-setup.ts` with that import and register it in the vitest config's `setupFiles`.
- [x] 1.6 Wire `packages/ui/src/main.tsx`: add `import './lib/i18n'` (side-effect, before `App`) and call `initLanguage()` next to the existing `initTheme()` call before `createRoot().render(...)`. Do NOT remove or reorder the existing `initTheme()`/`index.css` imports.

## 2. zh.json extraction + useTranslation wiring (per-area batches)

For each batch: (a) add the area's keys to `locales/zh.json` under a semantic nested namespace, (b) in each listed tsx file add `const { t } = useTranslation();` (or `const [t] = useTranslation();` to match the codebase's hook style) and replace each visible zh literal with `t('namespace.key')` or `t('namespace.key', { var })` for interpolated strings, (c) leave className/icon/`data-testid`/control flow untouched. Skip files in the batch that contain no visible zh strings.

- [x] 2.1 **Shell batch** — `src/App.tsx`, `src/components/shell/AppShell.tsx`, `src/components/shell/NavRail.tsx`, `src/components/shell/Stepper.tsx`. Keys under `nav.*`, `stepper.*`, `app.*`. Notable interpolations: `stepper.lockPending` → `还差 {{pending}} 项解锁`; `nav.daemonConnected`/`nav.daemonProbing`/`nav.daemonUnreachable`.
- [x] 2.2 **Settings batch** — `src/components/SettingsPage.tsx` (densest: ~30 strings). Keys under `settings.*` and `providers.*`. Notable interpolations: `settings.daemon.healthOk` → `已连接 ({{name}} {{version}})`; `settings.customProviderEditing` → `编辑自定义 Provider：{{id}}`; `settings.dataRepoPathHint` is a long sentence — keep as one key with no interpolation except where `${'...'}` JSX whitespace splicing exists (preserve the same rendered output). Provider labels: `providers.keyConfigured`/`keyNotConfigured`/`saveKey`/`replaceKey`/`clearKey`/`replace`/`cancel`/`edit`/`delete`/`update`/`add`/`custom`/`modelCount` (with `{{count}}`)/`empty`.
- [x] 2.3 **Picker batch** — `src/components/picker/SessionPicker.tsx`, `SessionCardGrid.tsx`, `SourceTree.tsx`. Keys under `picker.*` and `tree.*`.
- [x] 2.4 **Journey core batch** — `src/components/journey/DispositionWorkspace.tsx`, `ExitCards.tsx`, `QueueBar.tsx`, `src/components/SubmitPanel.tsx`. Keys under `journey.*`, `disposition.*`, `queue.*`, `submit.*`.
- [x] 2.5 **Journey exits / affirmation batch** — `src/components/journey/AffirmDialog.tsx`, `PublishWizard.tsx`, `BatchPublishWizard.tsx`, `BatchExitCards.tsx`, `BatchSubmitPanel.tsx`. Keys under `affirm.*`, `publish.*`, `batchExit.*`, `batchPublish.*`, `batchSubmit.*`.
- [x] 2.6 **Review / findings / warnings batch** — `src/components/FindingsTable.tsx`, `ReviewView.tsx`, `NonTextList.tsx`, `Layer3View.tsx`, `WarningsBanner.tsx`. Keys under `findings.*`, `review.*`, `nonText.*`, `layer3.*`, `warnings.*`.
- [x] 2.7 **Export & misc batch** — `src/components/ExportPreview.tsx` plus any remaining tsx with visible zh not covered above. Keys under `export.*` / area-appropriate namespace.
- [x] 2.8 **UI primitives sweep** — scan `src/components/ui/*.tsx` (`advanced-fold`, `badge`, `button`, `confirm-dialog`, `dialog`, `input`, `select`, `switch`, `tooltip`) for visible zh strings; wire only the files that have any (likely `confirm-dialog.tsx` and possibly `advanced-fold.tsx`). Most will have none and need no edit.

## 3. Stub locale files (key-mirror of zh)

- [x] 3.1 Produce `packages/ui/src/locales/ja.json`, `en.json`, `ko.json` by deep-cloning the `zh.json` key tree with every leaf value left equal to the zh source string (the placeholder). No key added, removed, renamed, or reordered relative to `zh.json`.
- [x] 3.2 Verify the four locale files have byte-identical key structure: for each top-level namespace and each leaf key in `zh.json`, the same key path exists in `ja`/`en`/`ko` with the same placeholder value. (A quick structural diff or a small node script comparing key-sets is sufficient — no test framework changes needed.)
- [x] 3.3 Confirm `lib/i18n.ts` imports all four JSON files (`zh`, `ja`, `en`, `ko`) into `resources` so switching languages at runtime resolves without a missing-resource warning.

## 4. Language switcher UI in SettingsPage

- [x] 4.1 Add a `LANG_OPTIONS` constant near `THEME_OPTIONS` in `SettingsPage.tsx`: `[{ id: 'zh', label: '中文' }, { id: 'ja', label: '日本語' }, { id: 'en', label: 'English' }, { id: 'ko', label: '한국어' }]`. Labels are endonyms and MUST NOT be passed through `t()` — they are fixed across all locales.
- [x] 4.2 Add a new `<section>` (heading `settings.language.label` = `语言`) that reuses the EXACT segmented-control pattern from the theme toggle: container `<div className="inline-flex rounded-md border border-border bg-surface-1 p-1" data-testid="lang-toggle">` with per-option `<button>`s styled by the same `cn('flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors', active ? 'bg-surface-2 text-foreground' : 'text-text-muted hover:text-foreground')`. Each button gets `data-testid={`lang-${opt.id}`}` and `aria-pressed={active}`.
- [x] 4.3 Track the active language in component state seeded from `getLanguage()` and kept in sync with `i18n.on('languageChanged', setLangState)` in a `useEffect` (cleanup with `i18n.off`). Click handler calls `setLanguage(opt.id)`; do not call `i18n.changeLanguage` directly — go through `lib/lang.ts` so persistence always happens.

## 5. Sanity checks + green build (all must pass before apply is done)

- [x] 5.1 Run a CJK-literal sweep over `packages/ui/src` excluding `locales/`: `grep -rP '[\x{4e00}-\x{9fff}]' packages/ui/src --exclude-dir=locales`. Remaining hits MUST be only inside code comments or type definitions — no rendered string literals. Fix any stragglers before declaring extraction complete.
- [x] 5.2 Run `npm run typecheck -w @mosga/ui` — green, zero new errors.
- [x] 5.3 Run `npm run build -w @mosga/ui` (or the root build that includes the UI workspace) — green; the Vite bundle includes all four locale JSONs.
- [x] 5.4 Run `vitest run` (root) — ALL existing UI tests green with ZERO test-file edits. `SettingsPage.test.tsx`'s `toContain('未配置')` / `toContain('已配置')` assertions are the canary; if they fail, the i18n init isn't wired into the test setup (revisit 1.5).
- [x] 5.5 Manual smoke (or browser QA): launch the app — it boots in `zh` and renders identically to the pre-change UI; the new language picker appears in Settings next to the theme toggle; clicking `日本語`/`English`/`한국어` re-renders the whole UI to the placeholder zh text live (no reload); selecting `中文` restores zh; the choice persists across a full page reload; the language picker's active button tracks the current language.
