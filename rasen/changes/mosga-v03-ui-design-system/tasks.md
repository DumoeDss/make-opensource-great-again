# Tasks — mosga-v03-ui-design-system

Ordered, individually completable. Pure restyle: ZERO behaviour change. Capability: `ui-design-system`. Reference source (READ-ONLY, MIT): `elftia/omnicross/packages/ui`. Do NOT touch archived artifacts (`rasen/changes/archive/**`, `openspec/**`).

## 1. Dependencies + alias foundation

- [x] 1.1 Add to `packages/ui/package.json` `dependencies`: `class-variance-authority ^0.7.0`, `lucide-react ^0.451.0`, `clsx ^2.1.1`, `tailwind-merge ^2.6.0` (keep `@mosga/*` at `"*"`). Do NOT add `@radix-ui/react-dialog` (deferred to slice 2). Run `npm install` from the repo root.
- [x] 1.2 Wire the `@` → `src` alias in `packages/ui/vite.config.ts` (`resolve.alias['@']` → `<pkg>/src`) and `packages/ui/tsconfig.json` (`baseUrl: "."` + `paths: { "@/*": ["src/*"] }`).
- [x] 1.3 Add the `@` alias to the root `vitest.config.ts` (`resolve.alias['@']` → `packages/ui/src`, via `fileURLToPath` like the existing `@mosga/*` entries).

## 2. Tokens + tailwind config

- [x] 2.1 Replace `packages/ui/src/index.css` with the ported omnicross token file: `@tailwind` layers + `@layer base` `:root` (light) + `.dark` tokens + the `* { @apply border-border }` reset + `html/body/#root` height + `body` font/background rules + the `--font-sans`/`--font-mono`/`--font-display` stacks. No bundled/external fonts.
- [x] 2.2 Replace `packages/ui/tailwind.config.js` with the ported extend: `darkMode: ['class']`, `theme.container`, and `theme.extend` `colors` (all tokens as `hsl(var(--…))`) / `fontFamily` / `fontSize` / `borderRadius` / `spacing`. Keep MOSGA `content: ['./index.html','./src/**/*.{ts,tsx}']`.

## 3. cn util + theme bootstrap

- [x] 3.1 Create `packages/ui/src/lib/cn.ts` — `cn(...inputs)` on `clsx` + `twMerge`, exporting `ClassValue`.
- [x] 3.2 Create `packages/ui/src/lib/theme.ts` — idempotent `initTheme()` that toggles the `.dark` class from `prefers-color-scheme` and subscribes to change events; guarded for non-browser. Call it once from `src/main.tsx` before `createRoot(...).render(...)`.

## 4. Primitive library (port + clean)

- [x] 4.1 Port `button.tsx`, `badge.tsx`, `input.tsx` into `packages/ui/src/components/ui/`, rewriting the `@/shared/utils/utils` import to `@/lib/cn`. No other change.
- [x] 4.2 Port `switch.tsx` and `tooltip.tsx` (same import rewrite). `tooltip` is already token-only.
- [x] 4.3 Port `select.tsx` (import rewrite) and STRIP every `wallpaper-panel` class from its dropdown containers (leave the `bg-popover` beneath). Confirm no `wallpaper-*` class remains in any ported primitive.
- [x] 4.4 Do NOT port `dialog.tsx` / `confirm-dialog.tsx` (slice 2). Typecheck the primitive files compile in isolation (final validation covers the whole package).

## 5. emoji → lucide

- [x] 5.1 `GateBanner.tsx`: replace 🔒/🔓 with `Lock`/`Unlock` (`strokeWidth={1.5}`); keep the phrases `Gate locked` / `Gate unlocked` so `contains('locked')`/`contains('unlocked')` assertions hold.
- [x] 5.2 `WarningsBanner.tsx` and `NonTextList.tsx`: replace ⚠ with `AlertTriangle` (`strokeWidth={1.5}`).

## 6. Restyle the 9 components (structure/behaviour/testids frozen)

- [x] 6.1 `App.tsx`: root wrapper → `bg-background text-foreground`.
- [x] 6.2 `Picker.tsx`: surface/border tokens; `recommended` pill → `Badge`; keep the h1 text `Select a session to review` verbatim and native `<select>`/`<input type=checkbox>` (restyled) with all testids.
- [x] 6.3 `ReviewView.tsx`: header + tab underline → `primary` tokens; error banner → `destructive` tokens; keep `restart`/`tab-*`/`tabs` testids (optional additive `ArrowLeft` on restart).
- [x] 6.4 `GateBanner.tsx`: locked/unlocked surfaces → `destructive`/`success` tokens; export `<button>` → `Button`; keep `sign-checkbox` native `<input>` and all testids.
- [x] 6.5 `FindingsTable.tsx`: disposition + batch `<button>`s → `Button`; table → surface/border tokens; `matchPreview` stays `font-mono`; keep every `disp-*`/`ack-*`/`batch-rule-*`/`finding-row-*`/`layer-filter` testid.
- [x] 6.6 `NonTextList.tsx`: cards → tokens; status pill → `Badge`; keep/remove → `Button`; keep `nontext-*` testids.
- [x] 6.7 `Layer3View.tsx`: stat cards → tokens; batch → `Button variant="subtle"`; keep `l3-*` testids.
- [x] 6.8 `ExportPreview.tsx`: chips → `Badge`; retint the `<pre>` to `bg-surface-2` + token text (JSON stays in slice 1; demotion to an Advanced fold is slice 2); keep `export-preview`/`export-empty` testids.
- [x] 6.9 `SubmitPanel.tsx`: native `<select>`s kept + restyled; estimate/ack/confirm → `Button`; panels → token surfaces; retint receipt `<pre>`; keep all `submit-*`/`ack-*` testids.

## 7. Validation

- [x] 7.1 Update only style-coupled expectations in the 4 test files if a restyle changed a queried text fragment; do NOT change any behavioural assertion. (No edits needed — all 4 UI test files pass unchanged.)
- [x] 7.2 Run `npm run typecheck -w @mosga/ui` (the `@` alias must resolve under `tsc`); fix until green.
- [x] 7.3 Run `npm run build -w @mosga/ui` (the `@` alias must resolve under Vite; Tailwind emits token utilities); fix until green.
- [x] 7.4 Run root `npm test` (`vitest run`) — all suites green, the 4 UI behavioural contracts intact; confirm the `@` alias resolves under vitest.
- [x] 7.5 Run `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v03-ui-design-system --strict` and fix any errors until it passes.
