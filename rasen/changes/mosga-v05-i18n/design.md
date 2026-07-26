## Context

`packages/ui` is a React 18 + Vite + Tailwind app served same-origin by `@mosga/daemon` and wrapped by the Tauri v2 shell (`apps/desktop`). It has **no i18n today**: every visible string is a Simplified-Chinese literal spread across ~45 tsx files. Two existing patterns are directly reusable:

- **Segmented control** — `SettingsPage.tsx` lines 191–217 render the three-state theme toggle as `<div className="inline-flex rounded-md border border-border bg-surface-1 p-1">` containing per-option `<button>`s toggled via `cn(...)`. The language picker copies this pattern verbatim with a `LANG_OPTIONS` array.
- **localStorage persistence** — `lib/theme.ts` is a self-contained module: `STORAGE_KEY='mosga-theme'`, a `hasWindow()` guard for jsdom/SSR, best-effort try/catch around storage get/set, an `applyTheme()` that both applies and persists, and an `initTheme()` called once from `main.tsx`. The new `lib/lang.ts` mirrors this shape.

`main.tsx` is the single mount point; it already calls `initTheme()` before `createRoot().render(<App/>)`. `SettingsPage.test.tsx` and ~12 other component tests assert on zh substrings (e.g. `expect(status.textContent).toContain('未配置')`) and render components directly without any provider — so the i18n strategy must let those assertions keep passing with **zero** test edits.

## Goals / Non-Goals

**Goals:**
- react-i18next infrastructure that renders the app byte-identically in `zh` (default + source).
- A settings-page language switcher with `localStorage` persistence, reusing the existing segmented control.
- Extract every visible zh string into `locales/zh.json` under semantic nested keys; wire `useTranslation()`/`t()` across the UI.
- Produce `locales/{ja,en,ko}.json` stubs whose key structure mirrors `zh.json` exactly, so the structure is locked and the app stays functional pre-translation.
- Keep `npm run build`, `npm run typecheck -w @mosga/ui`, and the existing component tests green with no test edits.

**Non-Goals:**
- Translating the `ja`/`en`/`ko` stub values — that is a separate LEAD-orchestrated parallel fan-out AFTER apply.
- Tauri shell Rust strings / native window titles (`apps/desktop`), daemon log/API messages, RTL, plurals/gender (not needed for this app's strings).
- Per-namespace lazy-loading, server-side language negotiation, or a daemon settings endpoint.

## Decisions

### Decision 1: react-i18next with synchronous bundled resources (no HTTP backend, no Suspense)

`lib/i18n.ts` runs `i18next.use(initReactI18next).init({...})` at module-evaluation time with all four locale JSONs imported as static Vite assets. `useTranslation()` therefore resolves synchronously on first render — no loading flash, no Suspense boundary, and component tests render translated output without an `I18nextProvider`.

**Alternatives considered:**
- *i18next-http-backend + lazy-load per language* — smaller initial bundle, but introduces a Suspense flash, an async gap that breaks tests rendering components directly, and a request to same-origin for a file we already ship. Rejected: the locale set is tiny and fixed (4 languages); bundle cost is negligible for a localhost/desktop app.
- *FormatJS / react-intl* — equally capable but a larger mental model (message AST, `defineMessages` boilerplate) and no clear win over the React ecosystem default. Rejected.
- *Lingui / paraglide* — compile-time approaches with smaller runtime, but add a build step and tooling the monorepo doesn't have. Rejected for this slice.

### Decision 2: Self-initializing module bound to the default i18n instance

`lib/i18n.ts` self-initializes on import and binds to react-i18next's default instance (the one `useTranslation()` reads when no provider is supplied). `main.tsx` imports `./lib/i18n` for its side-effect before rendering, and the test setup imports it once globally. **Components that call `useTranslation()` do NOT import `lib/i18n` directly** — that couples them to init order and risks double-init; they rely on the default instance being ready.

**Why:** keeps the component code `import { useTranslation } from 'react-i18next'` only; no provider wrapper needed; the same import works in app and test.

### Decision 3: `lib/lang.ts` mirrors `lib/theme.ts` (no subscriber pattern)

`lib/lang.ts` exposes `getLanguage()`, `setLanguage(lang)`, `initLanguage()`, and a `LANGUAGES` constant — same shape as `theme.ts`. **No `subscribers` Set** (unlike theme): react-i18next re-renders bound components automatically when `i18n.changeLanguage()` fires its `languageChanged` event, so a manual pub/sub is redundant. `setLanguage(lang)` persists to `localStorage['mosga-lang']` and calls `i18n.changeLanguage(lang)`; `initLanguage()` reads stored value (default `'zh'`, validated against the supported set), applies it, and is called from `main.tsx` next to `initTheme()`.

**Validation:** unknown stored values fall back to `'zh'` (whitelist-match like theme's `'light'|'dark'|'system'` check). All storage access wrapped in try/catch and guarded by `hasWindow()` for jsdom.

### Decision 4: Language switcher reuses the segmented control exactly

A new `<section>` is added to `SettingsPage.tsx`, placed directly above or below the theme toggle, containing the same `<div className="inline-flex rounded-md border border-border bg-surface-1 p-1">` shell with `LANG_OPTIONS = [{id:'zh',label:'中文'}, {id:'ja',label:'日本語'}, {id:'en',label:'English'}, {id:'ko',label:'한국어'}]` mapped to per-option buttons with `cn('flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors', active ? 'bg-surface-2 text-foreground' : 'text-text-muted hover:text-foreground')`. `data-testid="lang-toggle"` / `data-testid="lang-{id}"` for testability. Note: the option labels are intentionally NOT translated (each shows its own endonym) so a user can always find their language.

### Decision 5: Semantic nested keys; interpolation via `{{var}}`

Keys are namespaced by component/area (`nav.*`, `stepper.*`, `settings.*`, `journey.*`, `picker.*`, etc.). Dynamic substrings become interpolation parameters:

| Current literal | Key | Value (zh) |
|---|---|---|
| `贡献` | `nav.contribute` | `贡献` |
| `让数据捐赠有尊严` | `nav.subtitle` | `让数据捐赠有尊严` |
| `daemon 已连接` | `nav.daemonConnected` | `daemon 已连接` |
| `选择会话` / `处置命中` / `选择出口` | `stepper.step1` / `.step2` / `.step3` | (literal) |
| `` `还差 ${pending} 项解锁` `` | `stepper.lockPending` | `还差 {{pending}} 项解锁` |
| `已解锁` / `已完成` | `stepper.unlocked` / `.completed` | (literal) |
| `设置` | `settings.heading` | `设置` |
| `深浅模式` / `浅色` / `深色` / `跟随系统` | `settings.theme.label` / `.light` / `.dark` / `.system` | (literal) |
| `语言` | `settings.language.label` | `语言` |
| `` `已连接 (${name} ${version})` `` | `settings.daemon.healthOk` | `已连接 ({{name}} {{version}})` |
| `连接中…` / `不可达` | `settings.daemon.healthProbing` / `.healthUnreachable` | (literal) |
| `未配置` / `已配置` (key status) | `providers.keyNotConfigured` / `.keyConfigured` | (literal) |
| `保存密钥` / `更换密钥` / `清除密钥` / `编辑` / `删除` / `取消` / `更新` / `添加` | `providers.*` | (literal) |

Translators preserve `{{...}}` placeholders. No string-as-key anywhere.

### Decision 6: zh.json is the source; ja/en/ko are key-mirror stubs

`zh.json` is produced by extraction (the source of truth). `ja.json`, `en.json`, `ko.json` are generated by deep-cloning the zh key tree and leaving each leaf value equal to the zh string — i.e. before translation the app degrades to zh in every locale, which is safe. This locks the key structure so the parallel translation fan-out only overwrites leaf values (no key add/remove/rename).

## Risks / Trade-offs

- **[Bundle size: 4 locale JSONs shipped]** → Acceptable for a localhost/Tauri app. Vite can't tree-shake JSON values, but the total is a few KB (≈200–400 short strings). If it ever matters, switch the i18n init to lazy `import()` per language behind a Suspense boundary — a future change, not now.
- **[Tests rendering a translated component without the global i18n setup]** → `useTranslation()` would return the key as-is and break zh-substring assertions. Mitigation: the i18n module is imported from the test setup file (the one `vitest.config.ts`'s `setupFiles` references) so every test gets a initialized default instance. Verify with `SettingsPage.test.tsx` green as the canary.
- **[Translator misses/alters a `{{placeholder}}`]** → i18next renders the broken key as a fallback; visible bug only in that locale. Mitigation: the post-translation review-loop greps each non-zh locale for `{{` count parity against zh.json as a structural check; the spec calls this out as a scenario.
- **[String遗漏 (missed extraction)]** → A zh literal left in a tsx file silently renders in zh in every locale. Mitigation: a `grep -rP '[\x{4e00}-\x{9fff}]' packages/ui/src --exclude=locales` sanity check in tasks.md after extraction; remaining hits should be comments only.
- **[Interpolation collisions with quotes/apostrophes in translations]** → i18next escapes by default; we don't disable it. en values containing `'` are fine.
- **[Switcher position drift]** → Placing it next to the theme toggle is the lowest-surprise spot; the spec pins the control pattern so a reviewer can reject a reinvented control. The memory `控件像控件/别重复入口` is satisfied by reusing the exact segmented control.
