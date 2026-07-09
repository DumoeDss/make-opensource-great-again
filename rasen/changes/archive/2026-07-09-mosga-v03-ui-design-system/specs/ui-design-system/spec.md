## ADDED Requirements

### Requirement: Semantic design tokens with light and dark modes

`@mosga/ui` SHALL define semantic CSS custom properties, ported from omnicross, for both a light (`:root`) and a dark (`.dark`) theme. The token set SHALL include a 4-level `surface` scale, `text-strong`/`text-muted`/`text-subtle`, an `accent` of `hsl(15 56% 52%)` plus `accent-soft`, `success`/`warning`/`danger`, the shadcn aliases (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `destructive`, `border`, `input`, `ring`) each mapped onto the surface/text/accent tokens, a `--radius`, and `--font-sans`/`--font-mono`/`--font-display` stacks. No web-font files SHALL be bundled and no external font/CDN asset SHALL be referenced (the Tauri CSP forbids it); Inter and Georgia SHALL fall back through system stacks.

#### Scenario: Light tokens active by default

- **WHEN** the app renders without a `.dark` class on the document root
- **THEN** the light `:root` token values are in effect (warm-ivory surfaces, terracotta accent)

#### Scenario: Dark tokens active under the dark class

- **WHEN** the document root carries the `.dark` class
- **THEN** the dark token values override the light ones and every token-driven surface, text, and accent recolors accordingly

#### Scenario: No external or bundled font assets

- **WHEN** the UI is built and served under the daemon's `/ui` (Tauri CSP)
- **THEN** the font stacks resolve from system fonts with no bundled font file and no network font request

### Requirement: Follow-system theme by default

The UI SHALL default its theme to the operating system preference: on load it SHALL apply the `.dark` class when `prefers-color-scheme: dark` is set and remove it otherwise, and SHALL react to changes in that preference at runtime. This mechanism SHALL be presentation-only and SHALL NOT alter any review behaviour.

#### Scenario: System dark preference yields dark theme

- **WHEN** the OS reports `prefers-color-scheme: dark` at app load
- **THEN** the `.dark` class is applied to the document root and the dark tokens take effect

#### Scenario: Preference change is honored live

- **WHEN** the OS color-scheme preference changes while the app is open
- **THEN** the `.dark` class is toggled to match without a reload

### Requirement: Tailwind token configuration

The Tailwind config SHALL be extended (from omnicross) to expose the semantic tokens as utilities: `darkMode: ['class']`, a `colors` map binding `surface.{0..3}`, `text.{strong,muted,subtle}`, `primary`/`secondary`/`muted`/`accent`/`popover`/`card`/`destructive` (with their `foreground` pairs), `success`, `warning`, `border`, `input`, `ring`, `background`, `foreground`; a `fontFamily` map (`sans`/`mono`/`display`); the denser `fontSize` scale; `borderRadius`; and `spacing` additions.

#### Scenario: Token utilities compile

- **WHEN** a component uses a token utility such as `bg-surface-1`, `text-text-muted`, `border-border`, or `font-display`
- **THEN** Tailwind emits the corresponding `hsl(var(--token))` rule and the class renders with the token value

#### Scenario: Dark variant switches via class

- **WHEN** `darkMode: ['class']` is configured and the `.dark` class is present
- **THEN** token-bound utilities resolve to the dark token values

### Requirement: Class-combiner utility and path alias

The package SHALL provide a `cn(...inputs)` class-combiner at `src/lib/cn.ts` built on `clsx` + `tailwind-merge` (conflicting Tailwind classes de-duplicate, last-wins). The `@` path alias SHALL resolve to `src` consistently across the Vite build, the TypeScript typecheck, and the Vitest runner so ported primitives can import `@/lib/cn` and `@/components/ui/*`.

#### Scenario: cn merges and de-duplicates classes

- **WHEN** `cn('px-2', condition && 'px-4')` is evaluated with `condition` true
- **THEN** the result contains `px-4` and not `px-2` (tailwind-merge last-wins)

#### Scenario: Alias resolves in every toolchain

- **WHEN** a module imports from `@/lib/cn`
- **THEN** it resolves under `vite build`, `tsc --noEmit`, and `vitest run` without error

### Requirement: Component primitive library

`@mosga/ui` SHALL provide a `cva`-based component primitive library under `src/components/ui/`, ported from omnicross and cleaned of skin-only classes (`wallpaper-*`) that have no token backing here: `Button` (variants default/destructive/outline/secondary/ghost/subtle/link and sizes default/xs/sm/lg/icon), `Badge` (variants default/secondary/destructive/outline/success), `Input`, `Select`, `Switch`, and `Tooltip`. Each primitive SHALL style exclusively from the semantic tokens. `Dialog` and `ConfirmDialog` are explicitly NOT part of this slice (they require `@radix-ui/react-dialog`, deferred to the journey-shell slice).

#### Scenario: Button variants render from tokens

- **WHEN** `<Button variant="outline" />` and `<Button variant="destructive" />` are rendered
- **THEN** each applies its token-based classes (e.g. `border-border bg-surface-1` / `bg-destructive text-destructive-foreground`) via `cn(buttonVariants(...))`

#### Scenario: Primitives carry no skin-only classes

- **WHEN** any ported primitive is inspected
- **THEN** it contains no `wallpaper-solid` / `wallpaper-panel` (or other unbacked skin) classes

#### Scenario: Dialog primitives are absent in this slice

- **WHEN** the slice-1 primitive library is listed
- **THEN** `dialog` and `confirm-dialog` are not present and `@radix-ui/react-dialog` is not a dependency

### Requirement: Lucide icon language replaces status emoji

Status emoji SHALL be replaced by lucide-react icons rendered at `strokeWidth={1.5}`: the locked gate uses `Lock`, the unlocked gate uses `Unlock`, and non-text / ruleset warnings use `AlertTriangle`. No emoji SHALL remain as a status signal in `GateBanner`, `WarningsBanner`, or `NonTextList`.

#### Scenario: Gate lock state uses lucide icons

- **WHEN** the gate is locked, then unlocked
- **THEN** a `Lock` icon is shown while locked and an `Unlock` icon while unlocked, with no 🔒/🔓 emoji

#### Scenario: Warning surfaces use AlertTriangle

- **WHEN** ruleset warnings or non-text items are displayed
- **THEN** an `AlertTriangle` icon is shown in place of the ⚠ emoji

### Requirement: Restyle preserves review behaviour and test contracts

Applying the design system to the existing 9 review components SHALL be a pure restyle: component structure, disposition/gate/batch/409 behaviour, all `data-testid` attributes, the literal gate status phrases (`Gate locked` / `Gate unlocked`), the picker heading text `Select a session to review`, the redacted `matchPreview` rendering, and the native `<select>` / `<input type="checkbox">` elements the tests query SHALL be preserved. The 4 existing test files SHALL pass; only assertions bound to old style class names may be re-pointed to token classes, and no behavioural assertion SHALL change.

#### Scenario: Behavioural test contracts still pass

- **WHEN** the existing `GateBanner`, `FindingsTable`, `ReviewView`, and smoke test suites run after the restyle
- **THEN** every behavioural assertion passes unchanged (gate lock/unlock, disposition calls, batch delegation, non-text decrement, picker entry render)

#### Scenario: Gate status text remains substring-stable

- **WHEN** the gate is locked and then unlocked
- **THEN** the locked status text contains `locked` (and not `unlocked`) and the unlocked status text contains `unlocked`, matching the existing assertions

#### Scenario: Redacted preview never becomes a raw secret

- **WHEN** a finding is rendered in the restyled findings view
- **THEN** only its redacted `matchPreview` is shown, never a raw secret value
