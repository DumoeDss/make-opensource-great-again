# Review Report — mosga-v03-ui-design-system (slice 1: design system)

**Reviewer:** reviewer-s1 (adversarial; did not author the code)
**Date:** 2026-07-09
**Scope:** current uncommitted working-tree diff (tokens, tailwind config, `cn`/`theme` utils, 6 ported primitives, 9 restyled components, deps, alias wiring)

## Verdict: CLEAN

Zero Blockers, zero Majors. The slice honours its ZERO-behaviour-change contract: every `data-testid`, event handler, conditional, prop, native `<select>`/`<input type=checkbox>`, gate phrase, `matchPreview` rendering, and the Picker `h1` is preserved. Port fidelity is exact. Both gates re-run green independently.

## Gate re-run results (independently executed)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck -w @mosga/ui` (`tsc -p tsconfig.json --noEmit`) | PASS — no output/errors; `@` alias resolves under `tsc` |
| Tests | `npx vitest run` (root) | PASS — **39 files, 189 tests, all green**; 4 UI behavioural suites intact, unmodified |
| Spec validation | `rasen validate mosga-v03-ui-design-system --strict` | PASS — "is valid" |

## Finding counts by severity

Blocker: 0 · Major: 0 · Minor: 1 · Trivial: 3

## Detailed checks

### Port fidelity (vs omnicross source) — PASS
Diffed each ported file against `elftia/omnicross/packages/ui/src` with the `@/shared/utils/utils`→`@/lib/cn` import normalized:
- `button.tsx`, `badge.tsx`, `input.tsx`, `switch.tsx` — **byte-identical** except the import rewrite.
- `tooltip.tsx` — identical except import rewrite + 3 trailing-whitespace cleanups.
- `select.tsx` — identical except import rewrite + the **3 `wallpaper-panel` strips** at the dropdown containers (source lines 182/382/623), leaving the token-backed `bg-popover` beneath, exactly as `design.md` §select and task 4.3 specify. Confirmed omnicross carried `wallpaper-panel` at precisely those 3 sites.
- `src/index.css` — verbatim port of omnicross's `:root` + `.dark` tokens, `* { @apply border-border }` reset, and `html/body/#root` rules (only the header comment differs). Accent `hsl(15 56% 52%)`, 4-level surfaces, and the three `--font-*` stacks all present; no bundled/external font.
- `tailwind.config.js` — `darkMode: ['class']`, semantic `colors` (all `hsl(var(--…))`, incl. `primary.soft`→`--accent-soft` which the primitives consume), `fontFamily`, denser `fontSize`, `borderRadius`, `spacing`, `container`; MOSGA `content` retained.

### No skin/radix/external assets — PASS
Grep across `packages/ui/src` for `wallpaper-`, `@radix`, `@/shared`, external `https://` imports, `cdn.`, `googleapis` → **no matches**. No `@radix-ui/react-dialog`; `dialog`/`confirm-dialog` correctly deferred (absent from `src/components/ui/`).

### Zero-behaviour-change contract (9 restyled components) — PASS
Diff-read every component. All changes are className swaps to tokens, `<button>`→`<Button>` / status-pill→`<Badge>` substitutions (props incl. `onClick`/`disabled`/`data-testid` forwarded via `{...props}`), and additive lucide icons. No handler, conditional, prop, or state logic altered.
- **Frozen testids** verified present: `gate-*`, `export-button`, `sign-checkbox`, `disp-*`, `ack-*`, `batch-rule-*`, `finding-row-*`, `layer-filter`, `nontext-*`, `l3-*`, `export-preview`/`export-empty`, `submit-*`.
- **Gate strings**: locked renders "…未清零不解锁 — Gate locked" (contains `locked`, not `unlocked`); unlocked renders "Gate unlocked" (contains `unlocked`) — matches `GateBanner.test.tsx:16` and `ReviewView.test.tsx:49`.
- **Picker h1** `Select a session to review` unchanged.
- **Native elements** kept native: Picker source-select + show-all checkbox, FindingsTable layer-filter, SubmitPanel provider/model/mode selects + ack checkboxes, GateBanner sign-checkbox (only `accent-primary` added).
- **matchPreview**: FindingsTable renders only `f.matchPreview` in `<code>` (redacted); ExportPreview's raw `<pre>` JSON is a `SanitizedSession` (post-sanitize), so no raw secret path. Contract preserved.
- **Test files unchanged**: only `vitest.config.ts` changed among test-adjacent files (the `@` alias) — no `.test.tsx` was edited, and no surviving assertion targets the removed emoji/arrow/"recommended" text.

### Dark-mode bootstrap (`theme.ts`) — PASS
Idempotent (`initialized` guard), non-browser guarded (`typeof window`/`matchMedia` checks → inert under node, so the 4 component tests are unaffected), applies on load and subscribes to `change`. No listener removal, but this is a once-per-process lifetime bootstrap with no unmount, so no leak.

### Dependency hygiene — PASS
Exactly the 4 approved deps added to `packages/ui/package.json` dependencies: `class-variance-authority ^0.7.0`, `clsx ^2.1.1`, `lucide-react ^0.451.0`, `tailwind-merge ^2.6.0`. Lockfile resolves cva 0.7.1 / clsx 2.1.1 / lucide 0.451.0 / **tailwind-merge 2.6.1 (v2 — Tailwind 3 compatible)**. `@mosga/*` devDeps remain `"*"`. No `@radix-ui/*`.

## Findings

### [Minor] `Badge` (`<div>`) nested inside `<button>` in Picker
`packages/ui/src/components/Picker.tsx:112-119` — the "recommended" pill was a `<span>` (phrasing content) and is now a `<Badge>`, which renders a `<div>` (flow content), nested inside the project-select `<button>`. A `<div>` inside `<button>` is invalid per the HTML content model (browsers tolerate it; jsdom does not object, so no test breaks). This substitution is explicitly blessed by `design.md`/task 6.2, and there is no behaviour or testid impact — flagged only so the team knows a validity nit rode in with the Badge port. (NonTextList's Badge sits in a `<div>`, not a button — fine.) Optional: have `Badge` accept an `as`/render a `<span>`, or wrap differently, in a later slice.

### [Trivial] Stray ⚠ emoji survives in a tab label
`packages/ui/src/components/ReviewView.tsx:34` — `{ id: 'nontext', label: 'Non-text ⚠' }`. Confirmed **pre-existing** (identical at `HEAD`) and outside the three files the emoji→lucide contract scoped (GateBanner/WarningsBanner/NonTextList status signals). Not a contract violation; noted because it leaves one emoji visually adjacent to the new lucide language. Fold into slice 2's nav/tab restyle.

### [Trivial] ⚠ in a code comment
`packages/ui/src/components/NonTextList.tsx:16` — `⚠` appears in a JSDoc comment (not rendered). Harmless.

### [Trivial] Deps resolve above stated minimums
`class-variance-authority` resolved 0.7.1 and `tailwind-merge` 2.6.1 (ranges `^0.7.0`/`^2.6.0`). Expected caret behaviour; both stay within the intended major. No action.

## Notes
- CRLF warnings from git on the working tree are environmental (Windows autocrlf), not part of the change.
