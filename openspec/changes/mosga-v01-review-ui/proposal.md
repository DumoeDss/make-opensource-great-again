## Why

Slices 1–2 can discover, parse, and scan a session into a `SanitizationReport` with per-hit findings, a deterministic pseudonym mapper, and a computed gate — but there is no way for a human to act on it. The design doc makes human confirmation a **forced, non-optional gate**: Layer 1/2 (and every other blocking finding) must be enumerated and dispositioned item-by-item, non-text records confirmed one-by-one, and export stays locked until that is done. This slice builds the local review application — `@mosga/daemon` (a loopback HTTP API wrapping the existing packages, self-serving the UI) and `@mosga/ui` (a React review interface) — that turns the report into a review-and-unlock workflow. It is slice 3 of 4; slice 4 consumes the daemon's unlocked, stamped envelope.

## What Changes

- Add `@mosga/daemon`: a local HTTP server bound to `127.0.0.1` on a configurable port defaulting to **8899** (deliberately ≠ omnicross's 8766). It exposes a REST API over the existing packages and self-serves the built UI at `/ui` (same-origin, zero CORS — the omnicross pattern). No auth in v0.1 (loopback-only; the threat model is documented).
- **Enumeration + whitelist defense**: list adapters / projects / sessions via `@mosga/session-readers`, annotating each project with its git remote and a `recommended` flag; the picker defaults to projects with a public git remote (the design doc's "专有代码不泄漏" first line) and requires an explicit opt-in to show the rest.
- **Review lifecycle (stateful)**: a `POST /api/reviews` parses the chosen session (`adapter.parseTranscriptToMessages`, which carries the `nonTextContent` markers), wraps it in a `SanitizedSession` envelope, compiles the ruleset, runs `scanSession`, and holds the resulting `{ session, report, mapper }` server-side keyed by a review id. Disposition, batch, non-text, gate, preview, and export routes operate on that held state — because the `PseudonymMapper` instance (needed at export for `primaryContributorAlias()` and consistent placeholders) cannot round-trip through the browser.
- **Disposition API**: per-hit `replace`/`delete`/`allow`, one-click batch-by-rule and batch-by-type (reusing the deterministic pseudonym mapping), and non-text item `keep`/`remove` — each wrapping the sanitizer's pure report-transform helpers and returning the recomputed report + gate.
- **Export unlock**: a preview route (partially-applied session) and an export route that returns the stamped `SanitizedSession` (`meta.sanitized:true`, ruleset version stamped) only when the gate is unlocked, else 409. This stamped envelope is the hand-off to slice 4.
- A thin CLI entry (`mosga ui`-style) that starts the daemon and opens the browser.
- Add `@mosga/ui`: a React 18 + Vite + Tailwind interface — whitelist project/session picker, scan trigger, findings table (layer / rule / position / redacted preview / severity) with per-hit disposition, one-click batch controls, per-item non-text ⚠ list (block type + location; **rendering image bytes is not required for v0.1**) with confirm/exclude, a gate banner that stays locked until **every blocking finding kind** and all non-text items are dispositioned, a Layer-3 statistics + sample-check view, a signed confirmation summary ("命中项已全部处置 + 含图记录已逐条确认 + 抽检通过"), and an export preview of the sanitized envelope JSON once unlocked.
- **Render and gate on ALL blocking finding kinds**: not only L1/L2 secret/custom hits, but the engine's `ruleset-compile-error` and `redos-guard` findings (blocking, `layer:'secrets'`, some with `field:'rulesetMeta'`) and the `rulesetWarnings[]` returned by the scan. The gate already counts every `blocking` finding; the UI must surface these and let the user disposition them so they cannot be missed.

## Capabilities

### New Capabilities

- `review-daemon`: the `@mosga/daemon` package — loopback HTTP REST API wrapping session-readers + sanitizer, stateful review lifecycle holding the pseudonym mapper, git-remote whitelist recommendation, static UI serving at `/ui`, the export-unlock endpoint, and the CLI launcher.
- `review-ui`: the `@mosga/ui` package — the React review interface implementing the design doc's confirmation-gate semantics end to end (picker → scan → findings/dispositions/batch → non-text confirm → gate/signed summary → L3 stats/sampling → export preview).

### Modified Capabilities

<!-- None. `openspec/specs/` is empty (prior slices not yet archived); this slice adds new capabilities and consumes the shipped @mosga/session-readers and @mosga/sanitizer surfaces without modifying them. -->

## Impact

- **New packages**: `packages/daemon/` (`@mosga/daemon`) and `packages/ui/` (`@mosga/ui`), plus a daemon `bin` for the CLI launcher.
- **New dependencies**: daemon — a minimal HTTP framework (e.g. a small Node HTTP handler or `express`-class lib) + `zod` for request validation; ui — `react`, `react-dom`, `vite`, `tailwindcss`, and a dev test runner. The daemon serves the ui `dist`, so a build-order dependency exists (ui builds before daemon packages its static assets, or the daemon resolves the ui dist at runtime).
- **Consumes (unchanged)**: `@mosga/session-readers` (`listAdapters`/`getAdapter`, adapter `listProjects`/`listSessions`/`parseTranscriptToMessages`), `@mosga/sanitizer` (`compileRuleset`, `scanSession` → `ScanResult{report,mapper,rulesetWarnings}`, `setFindingDisposition`/`batchByRule`/`batchByType`/`setNonTextDisposition`, `applyDispositions` → `ApplyResult{session,stamped,gate}`, `computeGate`), and `@mosga/contracts` (`SanitizedSession`, `SanitizationReport`).
- **Downstream contract**: slice 4 (`@mosga/publisher`) consumes the daemon's export endpoint output — the stamped `SanitizedSession`. The daemon route set + gate-state model are fixed here for slice 4.
- **Out of scope** (later, must not bleed in): actual dataset export file-writing / GitHub PR flow / CI (slice 4 consumes the unlocked envelope), Tauri desktop shell, authentication, and multi-user/remote access. Also out of scope: a heavy end-to-end browser test suite (enhanced-verification territory later).
