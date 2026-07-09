# Design — mosga-v03-ui-design-system

File-level port plan for slice 1 of the frontend redesign. Authoritative product doc: `rasen/office-hours/frontend-ui-redesign.md` (section B1). Reference source (READ-ONLY, MIT): `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross\packages\ui`.

## Context

`@mosga/ui` is React 18 + Vite + Tailwind 3, built to `dist/` and served by `@mosga/daemon` at `/ui` (same-origin, base `/ui/`). Tests run from the repo root via `vitest run` against source; the 4 UI test files opt into jsdom with a `// @vitest-environment jsdom` header. omnicross is structurally identical (Tauri + daemon + React/Tailwind, local `/ui`), so its design system ports file-for-file. The whole slice is a restyle — no behaviour, no structure, no test-contract changes.

## Key decisions

1. **New `@` → `src` alias, wired in all three toolchains.** omnicross primitives import `@/shared/utils/utils` etc.; rather than rewrite every import (and re-rewrite in slices 2/3, which port many more `@/`-importing files), establish the alias once. Rewriting to relative paths was the lighter one-off but loses value across the portfolio; the alias is validated by the final typecheck + vitest + build task.
2. **`cn` uses clsx + tailwind-merge**, not omnicross's dependency-free combiner. The design doc explicitly adds `clsx`/`tailwind-merge`; the tailwind-merge dedupe (last-wins on conflicting utilities) is what lets restyled components layer token classes over base variant classes safely. Location `src/lib/cn.ts` (matches MOSGA's existing `src/lib/` convention). Ported primitives' `@/shared/utils/utils` import is rewritten to `@/lib/cn`.
3. **Defer `dialog` + `confirm-dialog` to slice 2.** They require `@radix-ui/react-dialog`, which is NOT in this slice's approved dependency set (cva, lucide-react, clsx, tailwind-merge), and no slice-1 component uses a dialog. Their real consumer is slice 2's "editing a disposition invalidates the signature and re-locks 出口④" confirm. Porting them here would add an unused dependency and dead code. The starter set is therefore the 6 no-radix primitives (button, badge, input, select, switch, tooltip).
4. **Native controls stay native in slice 1.** Existing components use `<select>` (source/project/layer/provider/model/mode) and `<input type="checkbox">` (show-all, sign, ack-tos, ack-retention). Swapping to the custom `Select`/`Switch` primitives is a structural change and would break the tests that query these as `HTMLSelectElement`/`HTMLInputElement` with `.disabled`/`.checked`. Slice 1 keeps native elements, restyled with token classes; the custom `Select`/`Switch`/`Input`/`Tooltip` primitives are ported as the library for slices 2/3. Only `Button` and `Badge` are substituted into existing markup (they map 1:1 to `<button>` / status-pill `<span>` without structural change).
5. **Follow-system dark via a tiny `theme.ts` bootstrap** in `main.tsx` (not a CSS `@media` block), because slice 2's three-state settings toggle overrides system preference by toggling the `.dark` class — the class mechanism must be the single source of truth. The bootstrap is presentation-only and outside the 4 test files' import graph (they render components, not `main.tsx`).
6. **New `ui-design-system` capability, `review-ui` untouched.** Presentation concerns land in a new capability; the review-ui behavioural spec + its test contracts stand as-is, encoding the zero-behaviour-change guarantee.

## Source → destination file map

| Action | omnicross source | MOSGA destination | Notes |
| --- | --- | --- | --- |
| Port (adapt) | `src/index.css` | `packages/ui/src/index.css` | Replace the 3 `@tailwind` lines with the full token file below. |
| Port (adapt) | `tailwind.config.js` | `packages/ui/tailwind.config.js` | Adopt `darkMode`+`theme.extend`; keep MOSGA `content` (`['./index.html','./src/**/*.{ts,tsx}']`). |
| Port (rewrite) | `src/shared/utils/utils.ts` | `packages/ui/src/lib/cn.ts` | Reimplement on clsx + tailwind-merge (see below). |
| New | — | `packages/ui/src/lib/theme.ts` | Follow-system `.dark` bootstrap. |
| Port (adapt) | `src/components/ui/button.tsx` | `packages/ui/src/components/ui/button.tsx` | Import `@/lib/cn`; no other change. |
| Port (adapt) | `src/components/ui/badge.tsx` | `packages/ui/src/components/ui/badge.tsx` | Import `@/lib/cn`. |
| Port (adapt) | `src/components/ui/input.tsx` | `packages/ui/src/components/ui/input.tsx` | Import `@/lib/cn`. |
| Port (clean) | `src/components/ui/select.tsx` | `packages/ui/src/components/ui/select.tsx` | Import `@/lib/cn`; strip `wallpaper-panel` classes. |
| Port (adapt) | `src/components/ui/switch.tsx` | `packages/ui/src/components/ui/switch.tsx` | Import `@/lib/cn`. |
| Port (adapt) | `src/components/ui/tooltip.tsx` | `packages/ui/src/components/ui/tooltip.tsx` | Import `@/lib/cn`. |
| Deferred | `dialog.tsx`, `confirm-dialog.tsx` | — (slice 2) | Need `@radix-ui/react-dialog`. |
| Edit | — | `vite.config.ts`, `tsconfig.json`, root `vitest.config.ts` | Add `@`→`src` alias. |
| Edit | — | `src/main.tsx` | Call the theme bootstrap. |
| Edit | — | `package.json` | Add the 4 deps. |
| Restyle | — | the 9 components + 4 test files | Token classes + Button/Badge + lucide; re-point style assertions. |

## Token CSS (`src/index.css`)

Ported verbatim from omnicross `index.css` (light `:root` + `.dark`, the `* { @apply border-border }` reset, and the `html/body/#root` height + `body` font/background rules). Key values: `--surface-0..3` warm ivory (light) / near-black (dark), `--text-strong/muted/subtle`, `--accent: 15 56% 52%`, `--accent-soft`, `--success/--warning/--danger`, shadcn aliases mapped onto them, `--radius: 0.5rem`, and:

```
--font-sans: 'Inter', system-ui, 'Segoe UI', Roboto, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Consolas, Menlo, monospace;
--font-display: Georgia, 'Times New Roman', serif;
```

(No `wallpaper-*` layer is ported — omnicross's `index.css` doesn't define one; those classes only appear in a few component files and are stripped there.)

## Tailwind config diff

Replace the empty `theme.extend` with omnicross's `darkMode: ['class']` + `theme` (`container`, and `extend` with `colors` / `fontFamily` / `fontSize` / `borderRadius` / `spacing`). `content` stays MOSGA's. `colors` binds every token as `hsl(var(--token))`: `border`, `input`, `ring`, `background`, `foreground`, `surface.{0..3}`, `text.{strong,muted,subtle}`, `primary{DEFAULT,foreground,soft}`, `secondary`, `destructive`, `muted`, `accent`, `popover`, `card`, `success`, `warning`. `fontFamily`: `sans`/`mono`/`display` → the `--font-*` vars. `fontSize`: the denser `micro/xs/sm/base/md/lg` scale (base `0.875rem`). This slightly shrinks default body text — the intended omnicross density; `xl`/`2xl` used by the two page headings remain Tailwind defaults.

## `cn` utility (`src/lib/cn.ts`)

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

## Theme bootstrap (`src/lib/theme.ts`)

Exports an idempotent `initTheme()` that reads `matchMedia('(prefers-color-scheme: dark)')`, toggles `document.documentElement.classList.toggle('dark', mq.matches)`, and subscribes to `mq` change events. Called once from `main.tsx` before render. Guarded for non-browser (`typeof window`/`matchMedia`) so it is inert under node. Slice 2 supersedes it with the settings three-state toggle.

## Component primitive library

Six primitives, all styling from tokens only, all importing `cn` from `@/lib/cn`:

- **button** — `cva` base + 7 variants (default/destructive/outline/secondary/ghost/subtle/link) × 5 sizes (default/xs/sm/lg/icon); `forwardRef<HTMLButtonElement>`; exports `Button`, `buttonVariants`.
- **badge** — `cva` base + 5 variants (default/secondary/destructive/outline/success); exports `Badge`, `badgeVariants`.
- **input** — token `<input>` with `density` (default/compact); `forwardRef`.
- **select** — custom portal dropdown (new `options` API + legacy compound API). **Strip** `wallpaper-panel` from the two dropdown containers (lines ~182, ~382, ~623 in source) — replace with the bare `bg-popover` they already carry. lucide `Check`/`ChevronDown`/`Search`. Library-only in slice 1.
- **switch** — controlled/uncontrolled token toggle button (`role="switch"`). Library-only in slice 1.
- **tooltip** — hover tooltip; already token-only (`bg-popover`, `border-border`, arrow via `hsl(var(--popover))`). Library-only in slice 1.

## New dependencies

Added to `packages/ui/package.json` `dependencies` (real semver; `@mosga/*` stay `"*"`):

| Package | Range | Why |
| --- | --- | --- |
| `class-variance-authority` | `^0.7.0` | primitive variant definitions |
| `lucide-react` | `^0.451.0` | icon language (matches omnicross) |
| `clsx` | `^2.1.1` | `cn` conditional class join |
| `tailwind-merge` | `^2.6.0` | `cn` conflicting-utility dedupe (v2 = Tailwind 3 compatible) |

Deferred: `@radix-ui/react-dialog` (slice 2). Then `npm install` from the repo root.

## emoji → lucide mapping

All rendered at `strokeWidth={1.5}`, sized via the primitive/util classes (e.g. `h-4 w-4`).

| Emoji | Where (file) | lucide icon |
| --- | --- | --- |
| 🔒 | `GateBanner.tsx` locked status | `Lock` |
| 🔓 | `GateBanner.tsx` unlocked status | `Unlock` |
| ⚠ | `WarningsBanner.tsx` header | `AlertTriangle` |
| ⚠ | `NonTextList.tsx` per-item marker | `AlertTriangle` |

Substring-safety: keep the phrases `Gate locked` / `Gate unlocked` (the icon is additive) so `GateBanner`/`ReviewView` assertions (`contains('locked')` / `contains('unlocked')`) still hold.

## Font stacks

Sans `'Inter', system-ui, 'Segoe UI', Roboto, sans-serif` (body, via `body` rule + `font-sans`); mono `ui-monospace, SFMono-Regular, Consolas, Menlo, monospace` (`matchPreview`, code, position via `font-mono`); display `Georgia, 'Times New Roman', serif` (`font-display`, reserved for slice 3 signing card — available now). No bundled font files; Inter/Georgia fall back through system stacks (Tauri CSP + zero-asset constraint).

## Per-component restyle (structure/behaviour/testids unchanged)

- **App.tsx** — root wrapper `bg-gray-50 text-gray-900` → `bg-background text-foreground`.
- **Picker.tsx** — h1 text `Select a session to review` unchanged (smoke test); gray borders/bg → surface/border tokens; `recommended` pill → `Badge variant="success"`; native `<select>`/`<input type=checkbox>` kept, restyled.
- **ReviewView.tsx** — header, tab underline (`border-indigo-600` → `border-primary`/`text-primary`), error banner → `destructive` tokens; restart link keeps testid; add `ArrowLeft` on the restart link (additive).
- **GateBanner.tsx** — locked/unlocked red/green → `destructive`/`success` token surfaces; `Lock`/`Unlock` icons; export `<button>` → `Button` (variant default/`disabled`); keep `sign-checkbox` as native `<input>`; keep gate phrases + all testids.
- **WarningsBanner.tsx** — amber → `warning` tokens; `AlertTriangle` icon.
- **FindingsTable.tsx** — disposition `<button>`s → `Button` (`size="xs"`, variant per state); batch buttons → `Button variant="subtle"`; table borders/`bg-gray-50` head → surface/border tokens; `matchPreview` stays `font-mono`; keep every `disp-*`/`ack-*`/`batch-rule-*`/`finding-row-*`/`layer-filter` testid.
- **NonTextList.tsx** — item cards → surface/border tokens; status pill → `Badge`; keep/remove `<button>`s → `Button`; `AlertTriangle` marker; keep `nontext-*` testids.
- **Layer3View.tsx** — stat cards → surface/border tokens; batch button → `Button variant="subtle"`; keep `l3-*` testids.
- **ExportPreview.tsx** — chips → `Badge`; the raw `<pre>` JSON stays for slice 1 (its demotion into an "Advanced" fold is slice 2's information-architecture work) but is retinted to `bg-surface-2`/token text; keep `export-preview`/`export-empty` testids.
- **SubmitPanel.tsx** — provider/model/mode native `<select>`s kept, restyled; estimate + ack + confirm buttons → `Button`; ack/estimate/receipt panels → token surfaces; receipt `<pre>` retinted (kept for slice 1); keep all `submit-*`/`ack-*` testids.

## Test-file updates (behaviour assertions frozen)

Only style-coupled expectations move: none of the 4 files assert on style class names today (they assert on testids, `.disabled`, `.checked`, textContent substrings, and mock-call args), so in principle no test edit is required. If a restyle incidentally changes a queried text fragment, re-point only that fragment; do NOT change any behavioural assertion. Verify by running the suite.

## Risks / mitigations

- **fontSize scale shrinks text globally** → intended density; page headings use default `xl`/`2xl`. Accept.
- **Alias misconfig passes build but fails vitest (or vice-versa)** → final task runs all three (typecheck, vitest, build) to catch drift.
- **tailwind-merge v3 targets Tailwind 4** → pin v2 for Tailwind 3.
- **`Unlock` vs `LockOpen` naming across lucide versions** → `Unlock` and `AlertTriangle` are stable in `^0.451.0`; verify import resolves at typecheck.
- **Stripping `wallpaper-panel` from Select** → cosmetic only (removes an undefined utility); the `bg-popover` beneath it is token-backed.
