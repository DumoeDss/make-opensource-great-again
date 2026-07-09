## Why

The current picker is a single-column, three-stage list (source `<select>` → project list → session list) where clicking a session immediately starts a review. For a user with many sessions this fails twice: browsing is cramped (no hierarchy at a glance, titles truncated with no way to see more, no timestamps at a glance), and there is no multi-select — each review means a full round trip back through the picker. The approved design doc (`rasen/office-hours/session-picker-batch-journey.md`, B1+B2) replaces it with the elftia-style layout the user pointed at: a left source→project tree (hover reveals the full path) and a right session card grid with single/multi/select-all, feeding a review QUEUE so ②处置→③签署 run per session back-to-back and the exits are chosen once at the end.

This slice is the pure-frontend half: the picker redesign and the queue journey. The batch exit backend (publisher multi-record plan + daemon batch routes) is slice 2; the batch exit UI is slice 3. For N>1 the exit step ships as a transitional summary page with placeholder batch-exit cards — the same placeholder pattern v03 slice 2 used for 出口①.

## What Changes

- **Tree-navigation picker** (`SourceTree`): left pane lists sources (CLI types) as group headers with project counts; expanding a source lazy-loads its projects (cache-on-expand). A project row shows its label + a `recommended` badge and reveals the full `cwd` path via a native `title` tooltip; clicking it loads that project's sessions into the card grid. The whitelist defense is preserved verbatim: `recommended` (public-git-remote) projects by default, an explicit show-all toggle at the tree top.
- **Session card grid with multi-select** (`SessionCardGrid`): responsive `auto-fill minmax(240px,1fr)` grid of cards — title (truncated, full title via `title` attr), relative time via `Intl.RelativeTimeFormat` (no new dependency), humanized size, and a selection checkbox; clicking a card toggles selection. Per-folder 全选/清空 controls. The selection set accumulates ACROSS folders and sources (keyed `sourceId+projectKey+sessionId`), capped at **20** (daemon `maxReviews` is 50 with LRU eviction; 20 keeps a wide margin). A persistent selection bar shows the count and the 「开始审阅 N 个会话」 CTA.
- **Queue creation**: the CTA serially POSTs `/api/reviews` per selected session with a "正在扫描 k/N" progress line; individual failures are listed and can be dropped so the successful remainder proceeds. Single-select yields a length-1 queue, behaviourally identical to today.
- **Queue journey** (`ReviewView` generalized): the journey container now owns a queue of reviews with per-item client-side `signed` state and a current index. A queue bar above the stepper shows 「会话 k/N · 标题」 plus clickable per-item states (待处理 / 当前 / 已签署). Steps ②③ operate on the current session; signing item k auto-advances to the next unsigned item; step ④ becomes enterable only when EVERY item is signed. The signature-void guard stays per item: editing any signed item's dispositions raises the existing ConfirmDialog, voids THAT item's signature, and re-locks ④. The server gate 409 remains the per-review backstop. Leaving the journey (① 换会话 / restart) with signed or in-progress items prompts a confirm (design Open Question 2, recommendation adopted).
- **Transitional exit step for N>1** (`BatchExitSummary`): a signed-sessions summary list with a per-item 「下载 .jsonl」 (existing `exportReview` + blob download) and disabled placeholder cards for 批量出口①/② ("将在后续切片可用"). N=1 renders the existing `ExitCards` unchanged.
- **Removed**: the old single-column `Picker` markup (replaced; `Picker.tsx` becomes the composition of tree + grid + selection bar, or is superseded by `SessionPicker.tsx` with `Picker.tsx` deleted).

## Capabilities

### New Capabilities

- `ui-session-queue`: the tree-navigation session picker (source→project tree with lazy loading, full-path hover, preserved whitelist defense), the multi-select session card grid (cross-folder selection set, select-all, the 20-item cap), queue creation with per-item failure handling, the per-session queue journey (queue bar, auto-advance on sign, all-signed gate for step ④, per-item signature void), and the transitional N>1 exit summary with placeholder batch-exit cards.

### Modified Capabilities

- `review-ui`: the "Whitelist project and session picker" requirement is re-presented — the entry flow becomes the tree + card grid and session selection feeds review creation (possibly plural). The whitelist defense (recommended-by-default + explicit show-all) and the create-review data flow are unchanged; scenario titles are preserved verbatim.

## Impact

- **Modified package**: `packages/ui/` only. ZERO daemon/publisher change; zero new dependencies (relative time uses the platform `Intl.RelativeTimeFormat`).
- **New files**: `src/components/picker/{SourceTree,SessionCardGrid,SessionPicker}.tsx`, `src/components/journey/{QueueBar,BatchExitSummary}.tsx`, `src/lib/format.ts` (relativeTime + formatBytes).
- **Edited files**: `App.tsx` (queue state `{ items, … }` replaces the single `review`), `ReviewView.tsx` (queue-aware journey container; keeps its filename), `components/Picker.tsx` (superseded/deleted), tests (`smoke`, `ReviewView`, new `SessionPicker`).
- **Test contracts**: the Picker h1 and single-column structure change (this is a MODIFIED requirement, not drift); gate/disposition/batch/non-text/409 semantics and their testids are untouched. Existing disposition-flow contracts are preserved against the generalized container; new tests cover multi-select, the cap, queue advance, all-signed gating, and per-item void.
- **Out of scope** (must not bleed in): daemon batch routes, publisher multi-record plan (slice 2); the batch exit wizard/batch direct-submit UI (slice 3); card-grid virtualization, search/filter, zip export (Later).
