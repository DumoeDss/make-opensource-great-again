## Why

Two rounds of direct UX fixes shipped after the mosga-v04 portfolio archived (commits 5b82612 and fbfce9f), changing the review journey's shape without a spec pass:

1. **Signing collapsed into one confirmation.** The per-session signing STEP (and its client-side per-item signature lifecycle) was replaced by a single donation-confirmation DIALOG raised before the FIRST exit action, whose summary aggregates ALL sessions in the queue. The journey went from four steps (①选择会话 ②处置命中 ③签署确认 ④选择出口) to three (①选择会话 ②处置命中 ③选择出口), and the lock badge from four states to three (还差 N / 已解锁 / 已完成).
2. **No-pressure donation affordances.** A one-click rule-based cleanup (session-level + queue-level, excluding meta/engine hits and non-text items) with auto-advance, plus per-session triage chips.
3. **Scoped tree selection.** Selection checkboxes on the whole-tree / per-source / per-project scopes, with the whitelist show-all control moved to the pinned BOTTOM of the tree pane.

This change is a documentation-only spec sync: it records the shipped behaviour so the specs match the code. No code changes.

## What Changes

- **`review-ui`**: the `Gate banner and signed confirmation summary` requirement is re-expressed as a one-time donation confirmation dialog (raised before the first exit action, aggregating the summary across the whole queue); its two scenario titles are preserved.
- **`ui-journey-shell`**: the `Persistent four-step stepper with lock badge` requirement becomes a three-step stepper with a three-state lock badge (scenario titles preserved); the `Signing ceremony card and client-side signature lifecycle` requirement is REMOVED (superseded); a new `One-time donation affirmation before the first exit action` requirement is ADDED.
- **`ui-session-queue`**: the `Per-session queue journey` requirement drops per-session signing in favour of whole-queue clear gating + triage (scenario titles preserved, bodies aligned to the shipped behaviour); the `Tree-navigation session picker` requirement notes the show-all control moved to the tree bottom; two new requirements are ADDED — `One-click rule-based cleanup with per-session triage` and `Scoped tree selection checkboxes`.
- **`ui-batch-exits`**: the `Batch publish wizard over the batch routes` requirement's signature-void wording is aligned to affirmation-void (scenario title preserved).

## Capabilities

### Modified Capabilities

- `review-ui`: donation confirmation re-expressed as a one-time, whole-queue dialog.
- `ui-journey-shell`: three-step stepper + three-state badge; signing ceremony removed; one-time affirmation added.
- `ui-session-queue`: whole-queue clear gating + triage; one-click cleanup and scoped tree selection added.
- `ui-batch-exits`: refusal jump-back guard re-worded to affirmation-void.

## Impact

- **Documentation only.** No `packages/**` change — this records behaviour already shipped in 5b82612 / fbfce9f.
- **Modified specs**: `review-ui`, `ui-journey-shell`, `ui-session-queue`, `ui-batch-exits`.
- **Known title drift**: several preserved scenario titles still say "signing" / "signed" / "unsigned" / "void only that item"; per the archive convention (MODIFIED scenario titles stay verbatim) the titles are kept and the scenario BODIES carry the corrected behaviour.
