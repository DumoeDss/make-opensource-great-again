# Tasks — mosga-v01-review-ui

Ordered, individually completable. Fixtures are ALWAYS hand-crafted fake data (fake secrets are obviously non-functional). Capabilities: `review-daemon`, `review-ui`. Consumes the shipped `@mosga/session-readers`, `@mosga/sanitizer`, `@mosga/contracts` surfaces unchanged.

## 1. Daemon package scaffold

- [x] 1.1 Create `packages/daemon/` (`@mosga/daemon`): ESM `package.json` (`exports`/`bin`), `tsconfig.json` extending base, `tsup.config.ts` (ESM + d.ts), `src/index.ts`. Depend on `@mosga/session-readers`, `@mosga/sanitizer`, `@mosga/contracts` (workspace `*`) and add `zod` for request validation + a minimal HTTP layer.
- [x] 1.2 Implement the HTTP server bound to `127.0.0.1` on a configurable port (default 8899, flag/env override); confirm it never binds a non-loopback interface. Add a smoke test so the root vitest runner picks up the package.
- [x] 1.3 Document the v0.1 threat model (loopback-only, no auth) in the package README/header.

## 2. Enumeration + whitelist routes

- [x] 2.1 Implement `GET /api/sources` (via `listAdapters`) and `GET /api/sources/:sourceId/projects` (via the adapter's `listProjects`); never throw on missing/unreadable trees.
- [x] 2.2 Implement `GET /api/sources/:sourceId/projects/:projectKey/sessions` (via `listSessions`), returning session refs.
- [x] 2.3 Implement the git-remote whitelist annotation: probe each project `cwd` for a git remote, mark `recommended` when it points to a recognized public host, include `gitRemote`/`recommendReason`; document the heuristic. Support a show-all vs recommended-only query.
- [x] 2.4 Vitest: sources list includes `claude-code`; projects annotated recommended/not against fake temp dirs (one with a public remote, one without); sessions enumerated from a fake fixture tree.

## 3. Review lifecycle + scan

- [x] 3.1 Implement the `SanitizedSession` envelope builder: parse via `adapter.parseTranscriptToMessages` (carries `nonTextContent`), fill `meta` (`sanitized:false`, `sanitizationRulesetVersion:null`, provisional `contributorAlias`, `sourceCli:'claude-code'`, tool version, ISO `exportedAt`), `session` from the ref, `schemaVersion` from contracts.
- [x] 3.2 Implement `POST /api/reviews`: compile the ruleset (`compileRuleset`), run `scanSession`, store `{ session, report, mapper }` in an in-memory map keyed by a generated `reviewId`; respond with `reviewId`, `report`, and `rulesetWarnings`.
- [x] 3.3 Implement `GET /api/reviews/:reviewId` (current report + gate) and a warnings accessor.
- [x] 3.4 Vitest: creating a review from a fake fixture returns a report + reviewId + rulesetWarnings; the stored mapper instance is reused at export (assert `contributorAlias` consistency).

## 4. Disposition, batch, gate routes

- [x] 4.1 Implement `POST /api/reviews/:reviewId/findings/:findingId/disposition` (via `setFindingDisposition`); validate the disposition value; return the recomputed report.
- [x] 4.2 Implement `POST /api/reviews/:reviewId/batch` for batch-by-rule (`batchByRule`) and batch-by-type (`batchByType`).
- [x] 4.3 Implement `POST /api/reviews/:reviewId/nontext/:messageUuid/disposition` (via `setNonTextDisposition`, keep/remove/pending).
- [x] 4.4 Implement `GET /api/reviews/:reviewId/gate` returning `computeGate`'s result; ensure `ruleset-compile-error` and `redos-guard` blocking findings are counted (no special-casing/filtering).
- [x] 4.5 Vitest: setting the last pending blocking finding flips `gate.unlocked`; batch-by-type replaces all of a category; an invalid disposition is rejected without mutating; a pending `ruleset-compile-error` finding keeps the gate locked until dispositioned.

## 5. Preview + gated export

- [x] 5.1 Implement `POST /api/reviews/:reviewId/preview` returning `applyDispositions(...)`'s partially-applied session.
- [x] 5.2 Implement `POST /api/reviews/:reviewId/export`: return the stamped `SanitizedSession` when `gate.unlocked`, else HTTP 409 with the gate; never emit a stamped session while locked.
- [x] 5.3 Vitest: export refused (409) while locked; after dispositioning all blocking + non-text items, export returns `meta.sanitized:true` with the ruleset version stamped and structure isomorphic to input.

## 6. Static serve + CLI launcher

- [x] 6.1 Serve the built `@mosga/ui` dist at `/ui` same-origin; resolve the dist path at runtime and fail clearly if absent.
- [x] 6.2 Implement the `mosga ui` CLI bin: start the daemon, open the browser at `/ui`; on a busy port, adopt an existing mosga daemon or report the conflict clearly.
- [x] 6.3 Vitest/integration: `/ui` serves the built assets same-origin; a missing dist yields a clear error.

## 7. UI package scaffold

- [x] 7.1 Create `packages/ui/` (`@mosga/ui`): Vite + React 18 + Tailwind, `package.json` build to `dist/`, TS config extending base, a typed API client that imports report/finding types from `@mosga/sanitizer` via `import type`.
- [x] 7.2 Add a component test runner (vitest + a React testing lib) and a smoke test.

## 8. UI review workflow

- [x] 8.1 Build the picker: source → project (recommended default + "show all" toggle) → session; create a review on selection and transition to findings on scan return.
- [x] 8.2 Build the findings table: layer / rule / position / redacted preview columns + per-hit disposition control (replace/delete/allow); filter by layer; virtualize/paginate the blocking list.
- [x] 8.3 Build one-click batch controls (by rule, by type) wired to the batch endpoint.
- [x] 8.4 Surface all blocking finding kinds: render `ruleset-compile-error`/`redos-guard`/`rulesetMeta` findings with an acknowledge/allow affordance; show `rulesetWarnings[]` as a banner; never hide or auto-clear them.
- [x] 8.5 Build the per-item non-text ⚠ list: block type + message location/context + confirm(keep)/exclude(remove); no image-byte rendering; show items resolved onto tool_use messages at their message.
- [x] 8.6 Build the gate banner (locked until `gate.unlocked`) + the signed confirmation summary ("命中项已全部处置 + 含图记录已逐条确认 + 抽检通过"); disable export while locked.
- [x] 8.7 Build the Layer-3 stats + sample-check view (byCategory counts + sampled findings; no per-item L3 gating).
- [x] 8.8 Build the export preview showing the stamped `SanitizedSession` JSON after unlock.
- [x] 8.9 Component tests: disposition control calls the client + updates gate counts; batch action; gate-locked banner + disabled export from a fixture report with a pending blocking finding; non-text confirm decrements `nonTextPending`.

## 9. Validation

- [x] 9.1 Run root `typecheck`, `build`, and `test` — all green; confirm no test reads real session data.
- [x] 9.2 Run `openspec validate --change mosga-v01-review-ui` (strict) and fix any errors until it passes.
