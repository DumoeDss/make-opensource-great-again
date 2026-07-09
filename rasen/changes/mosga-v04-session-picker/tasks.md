# Tasks — mosga-v04-session-picker

Ordered, individually completable. Pure `packages/ui` change; ZERO daemon/publisher change; ZERO new dependencies. Capability: `ui-session-queue` (new) + `review-ui` (modified). Design authority: `rasen/office-hours/session-picker-batch-journey.md` B1+B2 and this change's `design.md`. Do NOT touch archived artifacts or `rasen/changes/codex-session-reader/`.

## 1. Formatting utilities

- [x] 1.1 Create `src/lib/format.ts`: `formatRelativeTime(ms: number, nowMs?: number)` using `Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })` (thresholds per design.md; ≥7d falls back to `toLocaleDateString()`); `formatBytes(n: number)` humanizer. `nowMs` injectable for tests.
- [x] 1.2 Add `src/__tests__/format.test.ts` covering the threshold boundaries and the ≥7d fallback with fixed timestamps.

## 2. Picker — tree + card grid + selection

- [x] 2.1 Create `src/components/picker/SourceTree.tsx`: sources as expandable group headers (displayName + project count once loaded, lucide chevrons); expand lazy-loads projects once (cache-on-expand); project rows = label + recommended `Badge` + `title={cwd ?? key}`; `show-all-toggle` (existing testid + defense copy) at tree top; active project highlighted. Props: client-driven data in, `onSelectProject` out (controlled by SessionPicker).
- [x] 2.2 Create `src/components/picker/SessionCardGrid.tsx`: `grid gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]`; card = checkbox visual + truncated title with `title` attr + `formatRelativeTime(updatedAt)` + `formatBytes(sizeBytes)`; card click toggles selection; header row = folder label + 全选 (`select-all`) / 清空 (`clear-selection`); empty state.
- [x] 2.3 Create `src/components/picker/SessionPicker.tsx` composing 2.1+2.2: owns tree data fetches (`listSources`/`listProjects`/`listSessions` via the injected client), the cross-folder selection `Map` (key `${sourceId} ${projectKey} ${id}`, `MAX_BATCH = 20` with cap hint), the `selection-bar` (count + 「开始审阅 N 个会话」`start-review`), and queue creation: serial `createReview` per selection with 「正在扫描 k/N」 (`create-progress`); failures collected into `create-failures` list with 「继续（M 个成功）」/「返回选择」; emits `onQueueCreated(QueueItem[])` (QueueItem = `{ review, ref }`).
- [x] 2.4 Delete `src/components/Picker.tsx`; rewire `App.tsx`: state becomes `queue: QueueItem[] | null`; render `SessionPicker` when null, `ReviewView` (with `items={queue}`) otherwise. h1 becomes 「选择要审阅的会话」.

## 3. Queue journey

- [x] 3.1 Generalize `ReviewView.tsx` to `{ client, items: QueueItem[], onRestart }`: per-item state array (`reviewId/report/warnings/signed/exported`) + `current` index; derivations `cleared`(current) / `allSigned` / `maxEnterable = allSigned ? 4 : cleared ? 3 : 2`; all mutations target the current item; the void ConfirmDialog reads/writes the current item's `signed`. N=1 behaviour byte-identical to today (existing testids intact).
- [x] 3.2 Signing flow: `onSign` marks current signed; advance to next unsigned index (search from current+1, wrap) at step ②, or step ④ when `allSigned`. Step-nav buttons: ② ③ per current item; ④ disabled until `allSigned`.
- [x] 3.3 Create `src/components/journey/QueueBar.tsx` (rendered only for N>1): 「会话 k/N · <title>」 + per-item chips (`queue-item-<k>`: 待处理/当前/已签署 states, signed = CheckCircle2) that switch `current` on click (switching is allowed anytime; step clamps to that item's enterable max).
- [x] 3.4 Restart guard (design Open Q2): track `touched` (first successful mutation) — `onRestart` with `touched || any signed` opens a ConfirmDialog (`restart-confirm`, copy warns queue progress is discarded); confirm → restart, cancel → stay.

## 4. Transitional exit step

- [x] 4.1 Create `src/components/journey/BatchExitSummary.tsx` (N>1 step ④): signed-session summary list (title + sessionId + per-item 「下载 .jsonl」 `download-item-<sessionId>` via `client.exportReview` + Blob download, inline per-item error on failure) + disabled placeholder cards `exit-placeholder-one`/`exit-placeholder-two`（「批量出口将在后续切片可用」）.
- [x] 4.2 Wire step ④ in `ReviewView`: `items.length === 1` → existing `ExitCards` (unchanged props/behaviour); `> 1` → `BatchExitSummary`.

## 5. Tests + verification

- [x] 5.1 Add `src/__tests__/SessionPicker.test.tsx` per design.md test plan (fake client; lazy-load once, selection toggle/select-all/cross-folder/cap, serial create order + progress, partial-failure continue).
- [x] 5.2 Update `src/__tests__/ReviewView.test.tsx`: existing contracts on a 1-item queue; new queue cases (advance on sign, ④ all-signed gate, per-item void, N>1 renders `batch-exit-summary`, N=1 renders `exit-cards`).
- [x] 5.3 Update `src/__tests__/smoke.test.tsx` for the tree/grid happy path; update any other test touching the old Picker markup.
- [x] 5.4 From the repo root: `npm run typecheck` + `npm run build` + `npx vitest run --testTimeout=20000` all green; `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v04-session-picker --strict` passes.
