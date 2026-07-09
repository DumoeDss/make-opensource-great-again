# Tasks — mosga-v04-ux-spec-sync

Documentation-only spec sync — records behaviour already shipped (5b82612 / fbfce9f). No code tasks. MODIFIED/REMOVED requirement titles match the main `rasen/specs/**` verbatim (grep-verified).

## 1. Spec deltas

- [x] 1.1 `specs/review-ui/spec.md` (MODIFIED `Gate banner and signed confirmation summary`): one-time donation confirmation dialog before the first exit action, aggregating the summary across the whole queue; both scenario titles preserved.
- [x] 1.2 `specs/ui-journey-shell/spec.md`: MODIFIED `Persistent four-step stepper with lock badge` → three steps + three-state badge (3 scenario titles preserved); REMOVED `Signing ceremony card and client-side signature lifecycle`; ADDED `One-time donation affirmation before the first exit action`.
- [x] 1.3 `specs/ui-session-queue/spec.md`: MODIFIED `Per-session queue journey` (whole-queue clear gating + triage; 4 scenario titles preserved); MODIFIED `Tree-navigation session picker` (show-all at tree bottom; 3 scenario titles preserved); ADDED `One-click rule-based cleanup with per-session triage`; ADDED `Scoped tree selection checkboxes`.
- [x] 1.4 `specs/ui-batch-exits/spec.md` (MODIFIED `Batch publish wizard over the batch routes`): signature-void wording aligned to affirmation-void; scenario `Per-session refusal jumps back through the void guard` title preserved.

## 2. Verification

- [x] 2.1 `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v04-ux-spec-sync --strict` passes.
