# Design — mosga-v03-ui-journey-shell

Structural restructure of `@mosga/ui` into the NavRail shell + four-step journey. Authoritative product doc: `rasen/office-hours/frontend-ui-redesign.md` (B2 + B3); wireframe: `frontend-ui-redesign-wireframe.html` (3 screens). Builds on slice 1 (tokens, `@/lib/cn`, `@` alias, 6 primitives, `theme.ts`). Reference source (READ-ONLY, MIT): `elftia/omnicross/packages/ui` (NavRail `DaemonStatusBanner`/`useDaemonStatus`, `dialog`/`confirm-dialog`).

## Context

Today `App.tsx` toggles `Picker` ↔ `ReviewView`; `ReviewView` holds `report`/`signed`/`busy` state and renders a `GateBanner` + 5 tabs (`blocking`/`nontext`/`l3`/`export`/`submit`). The daemon exposes `/api/health` (`{name,version}`) and `/api/providers` (key-free list); no publish/preflight/data-repo endpoints exist yet (slice 3). Signing is already client-side (`signed` in `ReviewView`, dropped when the gate re-locks). This slice keeps all daemon calls identical and rebuilds the container.

## Key decisions

1. **New capability `ui-journey-shell` (ADDED) + `review-ui` MODIFIED (4 requirements).** The new surfaces (shell, stepper, workspace, signing card, exit cards, settings) are a new capability. The two `review-ui` requirements whose presentation is redefined (gate banner → lock badge + signing card; JSON export preview → summary + Advanced fold) plus the two that name "gate banner" incidentally (render-and-gate, cheap-tests) are MODIFIED so no spec asserts the old presentation. Behavioural scenarios are preserved; only presentation wording changes. Requirement *headers* stay identical (MODIFIED matches by header); the body carries the truth.
2. **`ReviewView` becomes the journey container** (keep the filename to minimize churn, or rename to `JourneyView` — implementer's call; if renamed, update `App.tsx` import). It keeps `client`/`report`/`signed`/`busy`/`error`/`exported` state, derives the current step + lock-badge state, and renders `Stepper` + the active step (②`DispositionWorkspace` / ③`SigningCard` / ④`ExitCards`).
3. **`GateBanner` dissolves** into (a) the `Stepper`'s lock badge and (b) `SigningCard`. Its test file is replaced by signing/stepper tests asserting the same contract (locked-until-cleared, checkbox disabled while locked, sign enables exit). This is the allowed structural test reorganization.
4. **Signature-void on ANY disposition change after signing**, not only on gate re-lock. Today `run()` drops `signed` only when `!next.gate.unlocked`. New rule (design B3 ③): when `signed` is true, any successful disposition mutation voids the signature and re-locks ④, guarded by a `ConfirmDialog` ("这将作废你的签署并重新锁定出口"). Cancel = no-op (no daemon call); Confirm = void + run the mutation. When not signed, the disposition path is unchanged (direct call) — so the existing disposition test contract holds.
5. **Dialog/ConfirmDialog port (radix), real consumer = the void guard.** Fulfils the slice-1 deferral; add `@radix-ui/react-dialog ^1.1.2`. Strip `wallpaper-solid` from `dialog.tsx` (leave `bg-surface-0`); `confirm-dialog.tsx` is already token-only. Import rewrite `@/shared/utils/utils` → `@/lib/cn`.
6. **Theme becomes three-state, in `SettingsPage`.** Extend `lib/theme.ts` from follow-system-only to a `light|dark|system` store with `localStorage` persistence: apply the class from the stored choice, and when `system`, subscribe to `prefers-color-scheme` (slice-1 behaviour becomes the `system` default). `main.tsx` calls `initTheme()` (reads persisted choice); the settings toggle sets it. No behavioural coupling to the 4 test files.
7. **No daemon changes.** Settings shows theme + daemon health (`/api/health` via a new `getHealth()` + `useDaemonStatus`) + read-only provider list (`/api/providers`). The data-repo-path display and preflight provider-key status are deferred to slice 3 (their endpoints don't exist yet). 出口① is a readiness placeholder — no publish call.
8. **`Badge` span fix (slice-1 reviewer Minor).** `Badge` currently renders `<div>`; nested in `Picker`'s `<button>` → invalid HTML. Change `Badge` to render a `<span>` (inline-flex already), which is valid inside a button and visually identical. Update its type to `HTMLSpanElement`. No other call site depends on it being a block.

## Component architecture

```
App
└─ AppShell            (NavRail + content router: 'contribute' | 'settings')
   ├─ NavRail          (logo/subtitle · 贡献/设置 nav · daemon-status footer)
   ├─ contribute:
   │   Picker          (step ① — unchanged; entry when no review)
   │   └─ ReviewView/JourneyView   (steps ②③④ container; owns report/signed/busy)
   │      ├─ Stepper   (4 steps + LockBadge; derives current step)
   │      ├─ ② DispositionWorkspace
   │      │     ├─ group nav (密钥命中/自定义规则/图像附件/归一化统计)
   │      │     ├─ batch suggestion cards
   │      │     ├─ FindingsTable      (reused; secrets/custom groups)
   │      │     ├─ NonTextList        (reused; 图像附件 group)
   │      │     ├─ Layer3View         (reused; 归一化统计 group, read-only)
   │      │     └─ WarningsBanner     (reused)
   │      ├─ ③ SigningCard    (Georgia title, summary, checkbox, sign)
   │      │     └─ ConfirmDialog (void-on-edit guard, hoisted to container)
   │      └─ ④ ExitCards
   │            ├─ 出口① readiness placeholder card
   │            ├─ 出口② SubmitPanel (reused) → receipt summary card
   │            ├─ 「仅导出脱敏文件」 → ExportPreview (summary + Advanced fold)
   │            └─ receipt = completion state (badge 已完成)
   └─ settings: SettingsPage  (theme toggle · daemon status · provider list)
```

## Step + lock-badge derivation (in the journey container)

- `pending = gate.blockingPending + gate.nonTextPending`
- `cleared = gate.unlocked` (server-authoritative)
- `completed = exit action succeeded` (submit receipt received, client state)
- **current step**: `!cleared` → ②; `cleared && !signed` → ③; `signed && !completed` → ④; `completed` → ④ done.
- **lock badge**: `!cleared` → `还差 {pending} 项解锁` (Lock); `cleared && !signed` → `已解锁` (Unlock); `signed && !completed` → `已签署` (CheckCircle2); `completed` → `已完成` (CheckCircle2, success).
- **gating**: ③ enterable iff `cleared`; ④ enterable iff `signed`.

## Disposition workspace groups

| Group | Source | Gates? | Component |
| --- | --- | --- | --- |
| 密钥命中 | blocking findings `layer==='secrets'` | yes | FindingsTable (filtered) |
| 自定义规则 | blocking findings `layer==='custom'` + meta | yes | FindingsTable (filtered) |
| 图像/附件 | `report.nonTextItems` | yes | NonTextList |
| 归一化统计 | `layer==='normalization'` | **no** | Layer3View (read-only) |

Group counts come from the existing report shape. Batch suggestion cards sit atop the queue: for each rule with >1 pending hit, a card "「{ruleId}」× {n} → 一键替换为化名" calls `client.batch(reviewId,'rule',ruleId,'replace')` (the existing FindingsTable batch path, promoted). The existing per-hit controls and testids inside FindingsTable/NonTextList/Layer3View are preserved so their behavioural tests keep passing.

## Files

**New**: `src/components/shell/NavRail.tsx`, `src/components/shell/AppShell.tsx`, `src/components/shell/Stepper.tsx`, `src/components/SettingsPage.tsx`, `src/components/journey/DispositionWorkspace.tsx`, `src/components/journey/SigningCard.tsx`, `src/components/journey/ExitCards.tsx`, `src/components/ui/dialog.tsx`, `src/components/ui/confirm-dialog.tsx`, `src/lib/useDaemonStatus.ts`, `src/components/ui/advanced-fold.tsx` (small `<details>`-based token-styled fold, or reuse native `<details>`).

**Edited**: `App.tsx`, `ReviewView.tsx` (→ journey container), `lib/theme.ts` (three-state), `main.tsx`, `api/client.ts` (+`getHealth`), `api/types.ts` (+`HealthResponse`), `components/ui/badge.tsx` (span), `package.json` (+radix), and the reused `FindingsTable`/`NonTextList`/`Layer3View`/`SubmitPanel`/`ExportPreview`/`WarningsBanner` (rehosted). **Removed/dissolved**: `GateBanner.tsx` (logic split into Stepper badge + SigningCard) — delete or reduce to the `SIGNED_SUMMARY` export it currently owns (move `SIGNED_SUMMARY` to `SigningCard` or a shared const).

## API additions (client only, no daemon change)

```ts
// types.ts
export interface HealthResponse { name: string; version: string; }
// client.ts ApiClient
getHealth(): Promise<HealthResponse>;   // GET /api/health
```
`getHealth` is additive; the test fakeClient/emptyClient stubs cast with `as ApiClient`, so a missing stub method still compiles. Add it to the fakeClient stub for cleanliness.

## dialog/confirm-dialog port

- `dialog.tsx`: port verbatim, rewrite import to `@/lib/cn`, **strip `wallpaper-solid`** from `DialogContent` (leave `bg-surface-0`). Keep the radix animation/`data-[state]` classes (tailwindcss-animate is not installed — the `animate-in`/`fade-in-0` utilities are inert without it, which is acceptable; do NOT add the plugin this slice).
- `confirm-dialog.tsx`: port verbatim, rewrite import to `@/lib/cn`. Already token-only; keep its `data-testid`s (`dialog-confirm`, `dialog-confirm-cancel-btn`, `dialog-confirm-ok-btn`).

## Test plan (contracts preserved, structure reorganized)

- **smoke.test** — render `App`; assert the NavRail shell renders and the picker heading `Select a session to review` is present under 贡献. Keep the emptyClient stub (add `getHealth`).
- **FindingsTable.test** — unchanged (FindingsTable still exists inside the workspace); behavioural contract intact.
- **GateBanner.test → SigningCard.test (+ Stepper/LockBadge test)** — locked report ⇒ signing card not actionable / lock badge shows remaining + exit disabled; cleared + affirmed ⇒ sign enables exit. Same contract, new components.
- **ReviewView.test → journey test** — disposition calls client + lock badge count updates; batch delegates (`'rule','aws-access-token','replace'`); non-text confirm decrements; **new**: after signing, changing a disposition shows the ConfirmDialog and, on confirm, voids the signature + re-locks ④ while still calling the daemon; exit ④ gated by signing. Use the existing `fakeClient` pattern (+`getHealth`).
- New **AppShell/NavRail** test — settings nav switches content; footer reflects health poll.

Behavioural assertions (gate lock semantics, daemon call args, non-text decrement, picker entry) are preserved verbatim in their new homes.

## Risks / mitigations

- **Void-on-edit could regress the disposition test** → the ConfirmDialog only intercepts when `signed` is true; unsigned disposition is the direct call the test exercises. Keep the guard `signed`-conditional.
- **Deleting GateBanner breaks its import in ReviewView** → remove the import when dissolving; move `SIGNED_SUMMARY`.
- **radix `animate-*` classes without tailwindcss-animate** → inert, not broken; dialogs open/close functionally. Defer the plugin.
- **Badge span change** → verify no call site relies on block layout; all current uses are inline pills.
- **Alias/deps** → final task runs typecheck + build + vitest (all three resolve `@` and radix) + `rasen validate --strict`.
- **Scope creep toward slice 3** → 出口① stays a placeholder; settings omits data-repo/provider-key rows; zero daemon edits.
