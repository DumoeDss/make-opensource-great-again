## Why

`@mosga/ui` today is a functional wireframe: Tailwind runs on stock defaults (no palette, no font settings, browser-default type), status is signalled with emoji (🔒🔓⚠), and every surface is a hand-rolled one-off `className`. The approved design doc (`rasen/office-hours/frontend-ui-redesign.md`) chose Approach B — journey redesign — and its first slice, **B1 设计系统层**, ports the Claude-flavoured design system MOSGA already owns in its sibling product **omnicross** (`elftia/omnicross`, MIT, same Tauri + daemon + React/Tailwind shape). The two products become "one family": same warm-ivory 4-level surface tokens, same terracotta accent, same Georgia display serif, same shadcn-style `cva` primitives, same lucide line-icon language, same `.dark` mode.

This slice is deliberately **pure restyle with ZERO behaviour change**. It lays the token + primitive foundation that slices 2 (`ui-journey-shell`) and 3 (`publish-exit-one`) build the new information architecture on top of. Nothing about disposition logic, the locked-until-clear gate, batch operations, or 409 handling moves — the existing 4 test files' behavioural contracts are preserved (assertions bound to old style class names may be re-pointed to token classes; behaviour assertions must not change).

## What Changes

- **Design tokens** ported from omnicross `packages/ui/src/index.css`: `:root` (light) + `.dark` semantic tokens — 4-level `surface`, `text-strong/muted/subtle`, `accent` `hsl(15 56% 52%)`, `success`/`warning`/`danger`, shadcn aliases (`background`/`foreground`/`card`/`popover`/`primary`/`secondary`/`muted`/`destructive`/`border`/`input`/`ring`), `--radius`, and the `--font-sans` / `--font-mono` / `--font-display` stacks. No web-font files are bundled (Inter / Georgia fall back through system stacks) — the Tauri CSP forbids external font/CDN assets.
- **Tailwind config** replaced with omnicross's extend: `darkMode: ['class']`, the semantic `colors` map, `fontFamily` (sans/mono/display), the denser `fontSize` scale, `borderRadius`, `spacing`, and `container`.
- **`cn` class-combiner** added at `src/lib/cn.ts` (clsx + tailwind-merge — the standard shadcn form; the extra dedupe over omnicross's dependency-free variant is why the design doc adds `clsx`/`tailwind-merge`).
- **`@` → `src` path alias** wired in `packages/ui/{vite.config.ts,tsconfig.json}` and the root `vitest.config.ts`, so ported omnicross primitives and future slices resolve `@/...` imports in build, typecheck, and test.
- **Component primitive library** ported into `src/components/ui/`: `button` (7 `cva` variants), `badge` (5 variants), `input`, `select`, `switch`, `tooltip` — cleaned of omnicross skin-only classes (`wallpaper-solid`/`wallpaper-panel`) that have no token backing here. `dialog` + `confirm-dialog` are **deferred to slice 2** (they require `@radix-ui/react-dialog`, which is outside this slice's approved dependency set, and have no consumer in slice 1).
- **New dependencies**: `class-variance-authority`, `clsx`, `lucide-react`, `tailwind-merge` (real semver ranges; internal `@mosga/*` deps stay `"*"`).
- **emoji → lucide** status icons (`strokeWidth={1.5}`): 🔒→`Lock`, 🔓→`Unlock`, ⚠→`AlertTriangle`, across `GateBanner`, `WarningsBanner`, `NonTextList`.
- **Restyle the 9 existing components** with tokens + `Button`/`Badge` where they map cleanly — WITHOUT touching structure, behaviour, `data-testid`s, the literal gate strings (`Gate locked`/`Gate unlocked`), the h1 text `Select a session to review`, `matchPreview` rendering, or the native `<select>`/`<input type=checkbox>` elements the tests query.
- **Follow-system dark mode**: a minimal `src/lib/theme.ts` bootstrap toggles the `.dark` class from `prefers-color-scheme` (wired in `main.tsx`). This is presentation-only and untouched by the 4 component tests (they render components directly, not `main.tsx`); slice 2's settings page replaces it with the three-state toggle (Open Question 1).

## Capabilities

### New Capabilities

- `ui-design-system`: the `@mosga/ui` presentation foundation — semantic light/dark design tokens, the Tailwind token config, the `cn` utility + `@` alias, the `cva` component primitive library (`button`/`badge`/`input`/`select`/`switch`/`tooltip`), the lucide icon language replacing emoji, and the constraint that restyling the existing review workflow preserves every behavioural contract.

### Modified Capabilities

<!-- None. The `review-ui` capability's behavioural requirements are intentionally left unchanged — this slice adds a presentation-layer capability and re-skins the components without modifying their behaviour, so the review-ui spec and its 4 test files' behavioural contracts stand as-is. -->

## Impact

- **Modified package**: `packages/ui/` (`@mosga/ui`) only. No daemon, contracts, sanitizer, or desktop changes.
- **New files**: `src/lib/cn.ts`, `src/lib/theme.ts`, `src/components/ui/{button,badge,input,select,switch,tooltip}.tsx`.
- **Edited files**: `src/index.css` (tokens), `tailwind.config.js` (token extend), `vite.config.ts` + `tsconfig.json` (`@` alias), `src/main.tsx` (theme bootstrap), `package.json` (deps), and the 9 components / 4 test files (restyle + re-pointed style assertions).
- **New dependencies**: `class-variance-authority` `^0.7.0`, `lucide-react` `^0.451.0`, `clsx` `^2.1.1`, `tailwind-merge` `^2.6.0`. Deferred: `@radix-ui/react-dialog` (slice 2).
- **Root config touched**: `vitest.config.ts` gains a `@` alias (no other package imports `@/`, so the mapping is inert for them).
- **Out of scope** (must not bleed in): NavRail / step-rail / four-step journey restructure and the settings page + three-state theme toggle (slice 2); daemon publish routes + 出口① wizard (slice 3); `dialog`/`confirm-dialog` primitives (slice 2); i18n framework, bundled fonts, any external network asset.
- **Verification**: root `typecheck` + `test` (vitest) green; `rasen validate mosga-v03-ui-design-system --strict` clean.
