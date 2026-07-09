# Review Report — mosga-v03-ui-journey-shell (slice 2: journey restructure)

**Reviewer:** reviewer-s2 (adversarial; did not author the code)
**Scope:** current uncommitted working-tree diff vs `git HEAD` (3ae2c3a), excluding LEAD bookkeeping (`rasen/changes/mosga-v03/*`).
**Effort:** high (structural rewrite)
**Verdict:** **FINDINGS** — no Blockers, no Majors. 2 Minor + 2 Trivial, all advisory. Behavioral conservation is intact; the change is shippable as-is. The one item that should not be left silent is the spec-text/impl mismatch on the L3 group (Minor F1).

---

## Gate re-runs (independently executed)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck -w @mosga/ui` | **PASS** (tsc `--noEmit`, clean) |
| Build | `npm run build -w @mosga/ui` | **PASS** (vite, 1651 modules, 3.83s) |
| Tests | `npx vitest run` (root) | **PASS** — 40 files, **194/194** tests |

---

## Behavioral conservation trace (the core risk) — PASS

Every daemon call site was compared against `git show HEAD:packages/ui/src/components/ReviewView.tsx`. All are invoked with identical arguments under equivalent conditions:

| Call | HEAD | Working tree | Status |
| --- | --- | --- | --- |
| `setDisposition(reviewId, findingId, d)` | `run(...)` direct | `guarded(...)` → `runMutation` | args identical ✓ |
| `batch(reviewId, 'rule', ruleId, d)` | direct | guarded | identical ✓ |
| `batch(reviewId, 'type', category, d)` | direct | guarded | identical ✓ |
| `setNonText(reviewId, messageUuid, d)` | direct | guarded | identical ✓ |
| `exportReview(reviewId)` + **409 branch** | `result.ok ? setExported : setError + setReport(gate)` | **identical** (`ReviewView.tsx:123-139`) | 409 backstop survives ✓ |
| `submit(...)` + **409 backstop** | `result.ok ? setReceipt : setError(...)` | `else setError` preserved (`SubmitPanel.tsx:107-113`) | survives ✓ |
| gate re-lock drops signature | `if (!next.gate.unlocked) setSigned(false)` | **identical** in `runMutation` (`ReviewView.tsx:79`) | ✓ |

**Gate derivation** (`ReviewView.tsx:62`): `pending = gate.blockingPending + gate.nonTextPending` — blocking + non-text only. Normalization is `gates:false` in the workspace (`DispositionWorkspace.tsx:92`) and never enters the count. ✓ Matches design "Step + lock-badge derivation."

**New behavior** (the only intended semantic addition): void-on-edit guard when `signed` — `guarded()` intercepts all four mutation paths, opens `ConfirmDialog`; confirm → void `signed`+`completed`, run mutation; cancel → no daemon call. Unsigned path is the unchanged direct call, so the pre-existing disposition contract holds. ✓

---

## Signing lifecycle correctness — PASS

- **Client-side only:** `signed`/`completed` are `useState` in the container; nothing persisted → refresh invalidates. ✓
- **Any disposition change after signing → ConfirmDialog → void + re-lock ④:** `guarded()` wraps `onDisposition`/`onBatchByRule`/`onBatchByType`/`onNonText` (`ReviewView.tsx:105-116`). ✓
- **Cancel = no-op:** `ConfirmDialog` cancel calls only `onOpenChange(false)`; `onConfirmVoid` runs solely from the OK button. Test `cancelling the void dialog makes no daemon call` confirms `setDisposition` not called and badge stays `已签署`. ✓
- **Server 409 backstop intact:** export + submit 409 paths unchanged (above). ✓
- **`pendingRef` safety:** on cancel the ref is not cleared, but it is only consumed by `onConfirmVoid` (OK) and is overwritten by the next `guarded()` before any re-open — no stale mutation can fire. ✓

**Edge cases requested:**
- **Batch disposition after signing** → `onBatchByRule` guarded ✓.
- **Non-text after signing** → `onNonText` guarded ✓.
- **L3 batch after signing** → `onBatchByType` guarded → **voids the signature**. L3 does not gate, so post-void the gate stays unlocked, `signed=false`, `maxEnterable` drops to 3, user is clamped back to ③ (`ReviewView.tsx:66-68`). This is *stricter* than gate semantics strictly require (L3 doesn't gate), **but it is consistent** (all four mutations guarded uniformly) and **defensible**: the signer affirms "抽检通过" over the L3 stats, so changing normalization dispositions legitimately invalidates that affirmation. Fail-safe (worst case = an unnecessary re-sign). **Implementation is internally consistent — accept.**

---

## Stepper / badge state machine — PASS

4 states derived correctly (`Stepper.tsx:37-77`): `!cleared → 还差 N` / `cleared&&!signed → 已解锁` / `signed&&!completed → 已签署` / `completed → 已完成`. Gating: ③ dimmed until `cleared`, ④ until `signed` (`Stepper.tsx:96`). Navigation (`ReviewView.tsx:141-147`) allows any step `≤ maxEnterable` plus ① restart; `maxEnterable = signed?4:cleared?3:2` permits backward moves — **no dead ends**. The clamp effect (`:66-68`) pulls the user back when a void/re-lock removes a later step. Completion keeps `signed=true`, so post-submit the user can still navigate back and edit (which re-triggers the void). ✓

---

## Deviation adjudications (explicit)

### Deviation (a) — Layer3View keeps its batch-by-type control inside the "read-only" 归一化统计 group → **ACCEPT, with a Minor spec-reconciliation note (F1)**

`Layer3View.tsx` is **unchanged from HEAD** (`git diff HEAD --stat` empty) and is reused verbatim in the normalization group; `DispositionWorkspace.tsx:184` forwards `onBatchByType` to it, so its `l3-batch-{cat}` buttons still call `client.batch(reviewId,'type',category,'replace')`.

- **Does the batch control still work in the new container?** Yes — full path `ReviewView.onBatchByType → guarded → runMutation → client.batch`, guarded when signed. Verified against the passing `ReviewView.test` batch contract and typecheck/build.
- **Is it acceptable?** For the slice's "behavior conserved" north star, **yes** — removing it would be the behavior change the slice forbids. But the delta spec text (`specs/ui-journey-shell/spec.md:43`) says the group "SHALL be **read-only** (statistics + spot-check), **produce no disposition**." The shipped UI produces dispositions there. The scenario ("does not gate … does not change the lock badge count", `:55-58`) is fully satisfied, so the *gating* intent holds; only the stronger literal "read-only / produce no disposition" is contradicted. This is a **Minor** finding: the archived spec would carry an inaccurate contract.

### Deviation (b) — receipt summary + Advanced fold inside SubmitPanel with additive `onSubmitted` callback → **ACCEPT, no finding**

`SubmitPanel.tsx` diff is clean and additive: `onSubmitted?` is optional (existing callers/tests unaffected), fires only on `result.ok` (409 → `setError` unchanged), and the receipt is re-rendered as a summary card (target/model/replayMode) with raw JSON demoted into `AdvancedFold`. Satisfies the dual-exit "render its receipt as a summary card" + "raw JSON in an Advanced fold" requirements. Keeping the summary local to SubmitPanel (rather than lifted to ExitCards) is a reasonable placement — the receipt is SubmitPanel-owned state. Clean.

---

## New primitives — PASS

- **dialog.tsx / confirm-dialog.tsx:** faithful omnicross port; `cn` import rewritten to `@/lib/cn`; `wallpaper-solid` stripped (`bg-surface-0` kept), matching the design directive. Radix provides focus-trap, Esc, `aria-modal`, and `aria-labelledby`/`describedby` via `DialogTitle`/`DialogDescription`. `confirm-dialog` keeps its `dialog-confirm*` testids. `animate-*` classes are inert (tailwindcss-animate not installed) but dialogs open/close functionally — documented and accepted.
- **advanced-fold.tsx:** native `<details>` disclosure (accessible by default), token-styled, chevron rotates on `group-open`, forwards `data-testid`. Good quality.

---

## Test quality — PASS (one Minor gap, F2)

The GateBanner.test deletion is genuine reorganization, not weakening. Deleted-assertion coverage map:

| Deleted GateBanner assertion | Re-expressed in |
| --- | --- |
| locked → sign-checkbox disabled | `SigningCard.test` "not actionable while locked" ✓ |
| locked → shows remaining count | `Stepper.test` `还差 3 项解锁` + `ReviewView.test` `还差 1` ✓ |
| locked → export disabled | `ReviewView.test` `goto-step-4` disabled (④ gated) ✓ |
| export enabled only when unlocked AND signed | `ReviewView.test` "signing gates the exit" (④ disabled until signed) ✓ |
| blocking-pending = 1 | lock-badge `还差 1` ✓ |
| **onExport fires when signed+unlocked** | **not re-tested** — see F2 |

New tests are strong: void-on-edit (confirm + cancel branches), signing gates exit, batch delegates (`'rule','aws-access-token','replace'`), non-text decrement, stepper 4-state transitions, AppShell nav switch, smoke asserts the NavRail shell. `getHealth` added to both fakeClient/emptyClient stubs.

**F2 (Minor):** no test exercises the `export-secondary` action → `onExport` → `client.exportReview` wiring, nor the export 409 branch. Note this is **not a regression** — the old suite never tested the 409-export branch either (the old GateBanner test only asserted the `onExport` callback fired). Advisory only.

---

## UX vs wireframe — PASS

Stepper always rendered (`ReviewView.tsx:166`); badge counts down per disposition; SigningCard only reachable at ③ (gated until cleared); exits are equal-weight (`grid md:grid-cols-2`, `ExitCards.tsx:40`); 出口① is a disabled readiness placeholder (no publish call); JSON demoted to `AdvancedFold` in both export preview and receipt. Matches B2/B3 and the wireframe.

---

## Findings

| ID | Severity | File:line | Finding | Recommendation |
| --- | --- | --- | --- | --- |
| F1 | Minor | `specs/ui-journey-shell/spec.md:43` vs `Layer3View.tsx:56-66` | Delta spec says the 归一化统计 group is "read-only … produce no disposition," but the reused Layer3View ships a working `batch replace all` control that produces `type` dispositions. Behavior is conserved & consistent (deviation a), but the archived spec would carry an inaccurate contract. | Soften the spec text to the gating intent ("does not gate / does not change the lock badge count") — which the scenario already states — OR remove the batch button in a follow-up if true read-only is desired. Prefer the former (keeps zero-behavior-change). |
| F2 | Minor | `ExitCards.tsx:84-98`, `ReviewView.tsx:123-139` | No test covers the `仅导出脱敏文件` → `exportReview` path or the export 409 branch. | Add one journey test clicking `export-secondary` and asserting `exportReview` is called (and a 409 result surfaces the error + refreshes gate). Non-blocking; not a regression. |
| F3 | Trivial | `ReviewView.tsx:213` + `Stepper.tsx:93` | After a successful submit (`completed`), navigating back to ② still shows badge `已完成` and all steps ✓ until an edit is confirmed (the badge briefly "lies"). | Optional: dim/reset the completed badge when `current < 4`. Cosmetic. |
| F4 | Trivial | `dialog.tsx:25,48,55,114` | Verbatim port retains non-MOSGA utility classes (`bg-black/80`, `ring-offset-background`, `text-muted-foreground`) that are inert if absent from the token config. | Optional token cleanup; harmless (port fidelity vs omnicross was the directive). |

---

## Summary

- **Blockers: 0 · Majors: 0 · Minors: 2 · Trivials: 2**
- Behavioral conservation (disposition/gate/batch/non-text/409/signing) fully verified against HEAD — intact.
- Both implementer deviations adjudicated: (a) L3 batch reuse = **accept** (behavior-conserving, consistent) with a Minor note to reconcile the spec wording; (b) receipt summary + `onSubmitted` = **accept**, clean.
- All three gates re-run green (typecheck / build / 194 tests).
- **Recommendation:** ship. Address F1 (spec-text reconciliation) before archive so the main specs don't inherit a false "read-only" contract; F2 is a nice-to-have test; F3/F4 are optional polish.
