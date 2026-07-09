# Tasks — mosga-v03-ui-journey-shell

Ordered, individually completable. Structural restructure of `@mosga/ui`; ZERO change to disposition/gate/batch/non-text/409 semantics or daemon routes. Capability: `ui-journey-shell` (new) + `review-ui` (modified). Reference (READ-ONLY, MIT): `elftia/omnicross/packages/ui`. Do NOT touch archived artifacts.

## 1. Dependencies + dialog primitives (slice-1 deferral)

- [x] 1.1 Add `@radix-ui/react-dialog ^1.1.2` to `packages/ui/package.json` `dependencies`; run `npm install` from the repo root.
- [x] 1.2 Port `src/components/ui/dialog.tsx` from omnicross: rewrite the `cn` import to `@/lib/cn`, STRIP the `wallpaper-solid` class from `DialogContent` (leave `bg-surface-0`). Do NOT add tailwindcss-animate (the `animate-*` classes stay inert).
- [x] 1.3 Port `src/components/ui/confirm-dialog.tsx` from omnicross: rewrite the `cn` import to `@/lib/cn`; keep its `dialog-confirm*` testids.
- [x] 1.4 Fix `Badge` (slice-1 reviewer Minor): render a `<span>` instead of `<div>` (type `HTMLSpanElement`) so it nests validly inside `Picker`'s `<button>`; visually identical.

## 2. Daemon-status plumbing (client only)

- [x] 2.1 Add `HealthResponse` to `api/types.ts` and `getHealth(): Promise<HealthResponse>` (GET `/api/health`) to the `ApiClient` interface + `apiClient` impl.
- [x] 2.2 Create `src/lib/useDaemonStatus.ts` — poll `getHealth()` on an interval, expose `{ status: 'ok'|'unreachable', name, version, address }` (address from `window.location.host`). Guard for tests.

## 3. Three-state theme

- [x] 3.1 Extend `src/lib/theme.ts` from follow-system-only to a `ThemeChoice = 'light'|'dark'|'system'` store: persist to `localStorage`, `applyTheme(choice)` toggles `.dark`, `system` subscribes to `prefers-color-scheme`. Export `getTheme`/`setTheme`/`initTheme`/`subscribe`. Keep `initTheme()` called from `main.tsx` (reads the persisted choice; default `system`).

## 4. Shell

- [x] 4.1 Create `src/components/shell/NavRail.tsx` — logo「MOSGA」+ subtitle, nav items 贡献 / 设置 (lucide icons, active state via tokens), daemon-status footer from `useDaemonStatus`.
- [x] 4.2 Create `src/components/shell/AppShell.tsx` — NavRail + content area with a `'contribute' | 'settings'` view state; render children/journey for contribute, `SettingsPage` for settings.
- [x] 4.3 Rewire `App.tsx` to mount `AppShell`; the contribute view keeps the Picker↔journey toggle (Picker when no review, journey container when a review exists). Preserve the `client` injection prop.

## 5. Stepper + lock badge

- [x] 5.1 Create `src/components/shell/Stepper.tsx` — the 4-step rail (①选择会话/②处置命中/③签署确认/④选择出口) with current/done marks (lucide `Check`) and a right-aligned `LockBadge` with the 4 states (`还差 N 项解锁`/`已解锁`/`已签署`/`已完成`) using `Lock`/`Unlock`/`CheckCircle2`. Props: current step, cleared, signed, completed, pending count. Steps ③/④ show gated (dimmed) when not enterable.

## 6. Step ② disposition workspace

- [x] 6.1 Create `src/components/journey/DispositionWorkspace.tsx` — left group nav (密钥命中/自定义规则/图像附件/归一化统计 with counts) + right queue that renders the reused `FindingsTable` (secrets/custom+meta filtered), `NonTextList` (图像附件), or `Layer3View` (归一化统计, read-only) for the selected group; keep `WarningsBanner` visible. 归一化统计 contributes no gate count.
- [x] 6.2 Add batch suggestion cards atop the queue: for each rule with >1 pending hit, a card calling the existing `onBatchByRule(ruleId,'replace')`. Reuse FindingsTable/NonTextList/Layer3View internals + testids unchanged.

## 7. Step ③ signing card + void-on-edit guard

- [x] 7.1 Create `src/components/journey/SigningCard.tsx` — Georgia (`font-display`) title「数据捐赠确认」, disposition summary (replace/delete/allow counts, non-text confirm counts, L3 stats + spot-check line), the affirmation checkbox with `SIGNED_SUMMARY` text, and a 「签署并继续」 button that unlocks step ④. Move `SIGNED_SUMMARY` here (or a shared const) from the dissolved `GateBanner`.
- [x] 7.2 In the journey container, wire the client-side signature lifecycle: signing sets `signed`; a report change that re-locks the gate drops it (existing behaviour). Add: when `signed` is true and the user triggers a disposition/batch/non-text change, show a `ConfirmDialog` («作废签署并重新锁定出口»); on confirm, void `signed` + run the mutation; on cancel, no-op (no daemon call). When not signed, run the mutation directly (unchanged path).

## 8. Step ④ exit cards

- [x] 8.1 Create `src/components/journey/ExitCards.tsx` — two equal cards. 出口①「公开数据集」: readiness-state placeholder describing the publish flow, disabled/"发布向导即将接入" CTA, NO daemon publish call. 出口②「API 直投」: render the reused `SubmitPanel`; render its receipt as a summary card (key fields) with the raw receipt JSON in an Advanced fold. Low-key secondary 「仅导出脱敏文件」 → the existing export → `ExportPreview`.
- [x] 8.2 On a successful 出口② submission, set `completed` so the stepper shows all-done + badge `已完成` (receipt = completion state, not a 5th step).
- [x] 8.3 Update `ExportPreview.tsx` and the receipt summary so the raw JSON lives inside an Advanced 「高级」 fold (native `<details>` or an `advanced-fold` helper), with a human-readable summary primary.

## 9. Journey container (ReviewView)

- [x] 9.1 Convert `ReviewView.tsx` into the journey container: keep `report`/`signed`/`busy`/`error`/`exported` state; derive current step + lock-badge state (pending/cleared/signed/completed); render `Stepper` + the active step (②`DispositionWorkspace` / ③`SigningCard` / ④`ExitCards`), replacing the 5-tab nav and the `GateBanner`. Preserve all daemon call sites (`setDisposition`/`batch`/`setNonText`/`exportReview`/submit) and the `onRestart` prop. Delete `GateBanner.tsx`.

## 10. Settings page

- [x] 10.1 Create `src/components/SettingsPage.tsx` — the three-state theme toggle (light/dark/system via `lib/theme.ts`), the daemon address + health (`useDaemonStatus`), and a read-only list of provider targets (`client.listProviders()`), no key material, no edit control. Do NOT add data-repo-path or provider-key-status rows (slice 3).

## 11. Tests (reorganize; preserve behavioural contracts)

- [x] 11.1 Update `smoke.test.tsx`: render `App`, assert the NavRail shell + picker heading `Select a session to review`; add `getHealth` to the emptyClient stub.
- [x] 11.2 Replace `GateBanner.test.tsx` with `SigningCard.test.tsx` (+ a Stepper/LockBadge test): locked report ⇒ lock badge shows remaining + exit disabled + signing not actionable; cleared + affirmed ⇒ sign enables exit. Same contract.
- [x] 11.3 Rework `ReviewView.test.tsx` into the journey test: disposition calls client + lock badge count updates; batch delegates (`'rule','aws-access-token','replace'`); non-text confirm decrements; step ④ gated by signing; after signing, a disposition change shows the ConfirmDialog and (on confirm) voids the signature + re-locks ④ while still calling the daemon. Add `getHealth` to `fakeClient`.
- [x] 11.4 Keep `FindingsTable.test.tsx` green (component reused). Add a small AppShell/NavRail test (settings nav switches content).

## 12. Validation

- [x] 12.1 Run `npm run typecheck -w @mosga/ui` (radix + `@` alias resolve); fix until green.
- [x] 12.2 Run `npm run build -w @mosga/ui`; fix until green.
- [x] 12.3 Run root `npm test` (`vitest run`) — all suites green; the review-ui behavioural contracts intact.
- [x] 12.4 Run `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v03-ui-journey-shell --strict` and fix until it passes.
