# Planning Context — mosga-v05-i18n

LEAD-seeded context for the planner. Read this FIRST, then research only what is missing.

## User intent (verbatim)

> 为mosga添加多语言支持，能够在设置中更换语言。包含中日英韩四种语言。先实现程序支持，然后再并行派各语言的subagent去翻译。开个worktree新建分支处理，完成后提pr。

Translation: Add multi-language support to mosga; switchable from Settings. Four languages: Chinese, Japanese, English, Korean. **First implement the program/i18n support, THEN dispatch parallel per-language subagents to translate.** Work in a worktree on a new branch; open a PR when done.

## Codebase findings (verified by LEAD)

- **Product**: mosga = "Make-OpenSource-Great-Again". Monorepo: `packages/*` + `apps/desktop` (Tauri v2 shell).
- **UI lives in `packages/ui`** — **React 18 + Vite + Tailwind**, served by `@mosga/daemon` at same-origin `/ui`. The Tauri shell just loads it. **All i18n work is scoped to `packages/ui`.**
- **No existing i18n** — clean slate (no react-i18next / react-intl / formatMessage anywhere). Confirmed via grep.
- **The app is currently in CHINESE.** Hardcoded zh string literals are scattered across **45 tsx files** (e.g. `SettingsPage.tsx` has `'浅色'/'深色'/'跟随系统'`, NavRail has `贡献/设置`, stepper has `①选择会话/②处置命中/③选择出口`). **Therefore `zh` is the default AND the translation source language**, not English.
- **Settings page exists**: `packages/ui/src/components/SettingsPage.tsx` — already has a three-state theme toggle, daemon address/health, provider management. **The language switcher goes here.** A `SettingsPage.test.tsx` exists — keep it green.
- **UI primitives**: `packages/ui/src/components/ui/` (button, select, switch, dialog, etc.) — a `select` or segmented control already exists for the theme toggle; reuse it for the language picker (memory: 控件像控件/别重复入口 — don't invent a new control type).
- **Entry point**: `packages/ui/src/main.tsx` (mounts `<App/>`). i18n provider initializes here.
- **Persistence**: settings persist today via `lib/theme.ts` (localStorage for theme). Language choice should persist the same way (localStorage) unless the daemon exposes a settings endpoint — check `api/client.ts`. Prefer localStorage for simplicity; the daemon is agnostic to UI locale.
- **Build/test**: `npm run build` / `npm run typecheck` / `vitest run` (root vitest.config.ts). UI has its own `tsc -p tsconfig.json --noEmit` typecheck via `npm run typecheck -w @mosga/ui`.
- **Convention**: existing changes are named `mosga-v0N-<slug>`; specs live under `rasen/specs/<capability>/spec.md` (capabilities include `review-ui`, `ui-journey-shell`, `ui-design-system`, `desktop-shell`). i18n is cross-cutting across all UI capabilities — propose a **new `ui-i18n` capability** spec rather than editing every existing one, UNLESS a cleaner home exists.

## Translation strategy (LEAD-decided; planner refines)

1. **apply stage** implements: react-i18next setup, i18n config module, **extraction of all current zh strings into `locales/zh.json`** (the source of truth), wiring `useTranslation` / `t()` across the 45 files, language switcher in SettingsPage, persistence, and **stub locale files for `ja`/`en`/`ko` that mirror `zh` keys** (values = the zh source string as a placeholder, so the app is functional pre-translation and the structure is locked). Build + typecheck + existing tests green.
2. **After apply, the LEAD fans out 3 parallel translation subagents** (ja, en, ko) — each reads `locales/zh.json` (source) and writes its own locale file with proper translations. Independent files, no overlap → safe parallelism. (zh needs no translation agent — it is the extracted source.)
3. **verify + review-loop** then review the complete diff (infra + all 4 locales).

Implication for tasks.md: the apply worker does NOT translate ja/en/ko itself — it only creates the key-structure stubs. Translation is a separate LEAD-orchestrated fan-out. Keep apply focused on infrastructure + zh + switcher.

## Constraints / decisions

- **Single coherent change — do NOT decompose.** i18n infra + locale files + switcher are tightly coupled and reviewable as one diff. This is a `small-feature`, not a portfolio.
- **zh is default + source.** App must render identically to today in zh (no visible change for existing users). `localStorage` key e.g. `mosga.lang`, default `'zh'`, falls back to `'zh'` on unknown values.
- **Library**: prefer **react-i18next** (i18next + react-i18next) — the React ecosystem standard, lazy-loadable, matches the stack. Avoid heavyweight alternatives.
- **Keys**: semantic nested keys (e.g. `settings.theme.light`, `nav.contribute`, `stepper.step1`), NOT string-as-key. Namespace by component/area.
- **Plurals/gender**: likely not needed for this app's strings; skip unless a clear case appears.
- **Don't break non-string UI**: keep className logic, icon imports, etc. untouched — only swap visible text literals for `t('key')`.
- **Working tree**: branch `worktree-mosga-i18n` in worktree `.claude/worktrees/mosga-i18n`. Ship = PR to `DumoeDss/make-opensource-great-again` (GitHub, `origin`).
- **rasen CLI is on PATH** in this shell (`rasen` works, v0.1.5 fork with pipeline/agent subcommands). Workers use `rasen <cmd>` directly — no long node path needed.

## Out of scope

- Translating the Tauri shell's Rust strings / window titles (apps/desktop) — the shell loads the web UI; native menus are minimal. Note as future work if found, don't block.
- Translating daemon log messages or API responses (server-side stays English/zh as-is).
- RTL layouts — none of zh/ja/en/ko need RTL.
