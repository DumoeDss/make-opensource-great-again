## Context

Slices 1–2 shipped `@mosga/contracts`, `@mosga/session-readers`, and `@mosga/sanitizer`. The sanitizer's real surface (read from the shipped code, not memory) is the contract this slice binds to:

- `scanSession(session, ruleset, opts) → ScanResult { report: SanitizationReport, mapper: PseudonymMapper, rulesetWarnings: RulesetWarning[] }`.
- Report/finding model: `SanitizationReport { reportVersion, sanitizationRulesetVersion, sessionId, generatedAt, findings[], layerSummary{secrets,custom,normalization}, nonTextItems[], gate{blockingTotal,blockingPending,nonTextPending,unlocked} }`. `Finding { id, layer, ruleId, category?, location, matchPreview(redacted for secrets/custom), replacementSuggestion, disposition, blocking }`. `Disposition = pending|replace|delete|allow`. `NonTextItem { messageIndex, messageUuid, blockTypes[], disposition: pending|keep|remove }`.
- Disposition helpers are **pure report transforms** returning a recomputed report: `setFindingDisposition(report, findingId, d)`, `batchByRule(report, ruleId, d)`, `batchByType(report, category, d)`, `setNonTextDisposition(report, messageUuid, d)`.
- `applyDispositions(session, report, mapper) → ApplyResult { session, stamped, gate }` — stamps `meta.sanitized:true` + `sanitizationRulesetVersion` + `contributorAlias` (from `mapper.primaryContributorAlias()`) ONLY when the gate is unlocked, else returns a preview (`stamped:false`).
- Two post-propose sanitizer review fixes that changed the surface this slice must honor: (1) rules that fail to compile on the consumer runtime surface as `rulesetWarnings[]` AND, when they cannot degrade to a keyword matcher, as a **blocking gating finding** `ruleId:'ruleset-compile-error'` with `location.field:'rulesetMeta'`; (2) the ReDoS/oversize guard emits a **blocking** finding `ruleId:'redos-guard'`. Both are `layer:'secrets'`, `blocking:true` — so `computeGate` already counts them, and the UI must render and gate on them like any other blocking hit.
- `PseudonymMapper` is a stateful class; `primaryContributorAlias()` reads scan-time state. `claudeCodeAdapter.parseTranscriptToMessages` already delegates to `parseClaudeSession`, so it yields `ParsedMessage[]` carrying `nonTextContent` markers (including markers resolved onto tool_use messages).

The design doc requires a GUI (terminal UX cannot do finding enumeration + batch replace + per-item image preview), a forced human-confirmation gate (未清零不解锁), and a whitelist project picker as the first line of the "专有代码不泄漏" defense. omnicross's shipped shape — a loopback daemon that self-serves `/ui` so the browser talks same-origin with zero CORS — is the template (port 8766 there; we use a different port).

## Goals / Non-Goals

**Goals:**

- A loopback daemon exposing a REST API over the existing packages, self-serving the React UI same-origin, launchable via a thin CLI.
- A React review interface implementing the confirmation-gate workflow: whitelist picker → scan → findings table with per-hit + batch dispositions → per-item non-text confirmation → locked-until-clear gate + signed summary → L3 stats/sampling → export preview of the stamped envelope.
- Correctly render and gate on EVERY blocking finding kind, including `ruleset-compile-error` and `redos-guard`, plus surface `rulesetWarnings[]`.
- Produce, on unlock, the stamped `SanitizedSession` that slice 4 consumes.

**Non-Goals:**

- No dataset export file-writing, GitHub PR flow, or CI (slice 4).
- No Tauri desktop shell, no authentication, no multi-user/remote access.
- No image-byte rendering for non-text items in v0.1 (show block type + location + context).
- No heavy end-to-end browser test suite (later enhanced verification); daemon API integration tests + cheap UI component tests only.
- No changes to the shipped `@mosga/session-readers` / `@mosga/sanitizer` / `@mosga/contracts` source.

## Decisions

### D1 — Stateful server-side review session (holds the mapper)

`POST /api/reviews` runs the pipeline once and stores `{ session, report, mapper }` in an in-memory map keyed by a generated `reviewId`; all subsequent routes mutate the held `report` (via the pure sanitizer helpers) and read the held `mapper` at export. Rationale: the disposition helpers are pure report transforms (so the report itself could round-trip), but `applyDispositions` needs the **same `PseudonymMapper` instance** for `primaryContributorAlias()` and placeholder consistency, and the mapper's internal counters/tables do not cleanly serialize to the browser and back. Holding state server-side is the simplest correct design. *Alternative:* stateless with per-request re-scan (deterministic — `Finding.id` is stable — replaying stored dispositions). Rejected for v0.1: re-scanning every request is wasteful and re-deriving the mapper each time is fragile. Trade-off: in-memory state is lost on daemon restart (documented; a re-scan reproduces identical `Finding.id`s so the user can redo, and no data is corrupted).

### D2 — Same-origin static serve, loopback-only, no auth

The daemon binds `127.0.0.1` only and serves the built UI from the `@mosga/ui` dist at `/ui`, so the browser calls the API same-origin (zero CORS config — omnicross pattern). v0.1 has **no authentication**: the threat model is a single local user; any process able to reach loopback can hit the API and read the session under review. This is acceptable for a local dev tool and is documented prominently (the API never binds a non-loopback interface; a future auth token is a v0.2 option). *Alternative:* a Vite dev server proxying to the daemon — fine for development, but production/`npx` use serves the built dist from the daemon so there is a single origin and process.

### D3 — Configurable port (default 8899), simple lifecycle, CLI launcher

Default port **8899** (≠ 8766), overridable by flag/env. The CLI entry starts the daemon and opens the default browser at `/ui`. If the port is already in use, the launcher reports it clearly (and can adopt an already-running mosga daemon on that port rather than spawning a second). Full omnicross-style adopt-or-spawn negotiation is trimmed to "adopt if it's our daemon, else fail with a clear message" for v0.1.

### D4 — Git-remote whitelist recommendation (design doc first defense)

`GET .../projects` annotates each project with `{ gitRemote: string|null, recommended: boolean, recommendReason }`. The daemon probes the project `cwd` for a git remote (e.g. reading `.git/config` / `git remote get-url`) and marks `recommended:true` when the remote points to a recognized public host (github.com / gitlab.com / bitbucket.org / …). The picker shows recommended projects by default and hides the rest behind an explicit "show all projects" opt-in. This is a **recommendation, not enforcement** — the real defenses are the scan + the human gate; the flag is a convenience filter that biases the user toward public-code projects, and its heuristic nature (a private mirror on a public host, or an unpushed repo) is documented. *Alternative:* a live network reachability probe of the remote — rejected for v0.1 (network dependency, slow, still not authoritative).

### D5 — Render and gate on ALL blocking finding kinds

`computeGate` counts every `Finding` with `blocking:true`, which already includes `ruleset-compile-error` and `redos-guard`. The UI MUST NOT filter the findings table to only L1/L2 rule hits: engine/meta findings (`ruleId` ∈ `ruleset-compile-error` | `redos-guard`, `field:'rulesetMeta'` for compile errors) must appear as blocking rows the user has to disposition, and `rulesetWarnings[]` must surface as a banner. A `rulesetMeta` finding has a zero-width span and no editable text (apply ignores it), so its meaningful disposition is `allow` (acknowledge — "I have reviewed this rule-coverage gap"); dispositioning it to non-`pending` is what clears it from `gate.blockingPending`. The UI presents these with an "acknowledge / reviewed" affordance rather than replace/delete.

### D6 — Non-text items: type + location, no image bytes (v0.1)

Non-text ⚠ items render from `NonTextItem { messageIndex, messageUuid, blockTypes[] }` — showing the block type(s), the message location/index, and surrounding text context — with per-item `keep` (confirm) / `remove` (exclude) actions. v0.1 does not decode/display image bytes; the design doc's requirement is per-item human confirmation, which type + context satisfies. A marker that the reader resolved onto a tool_use-carrying assistant message is shown at that message (the daemon passes `messageIndex`/`messageUuid` straight through).

### D7 — Export contract (hand-off to slice 4)

`POST /api/reviews/:id/preview` returns `applyDispositions(...)`'s partially-applied session for display. `POST /api/reviews/:id/export` returns the stamped `SanitizedSession` (`meta.sanitized:true`, `sanitizationRulesetVersion` set, `contributorAlias` filled) when `gate.unlocked`, else HTTP 409 with the current gate. The stamped envelope JSON is exactly what slice 4's publisher consumes; the daemon does not itself write dataset files or open PRs.

### D8 — Request/response validation with the shared schemas

The daemon validates request bodies (disposition values, batch keys, review ids) with `zod` and returns typed JSON. Responses reuse the sanitizer's `SanitizationReport` shape verbatim so the UI's types come straight from `@mosga/sanitizer` via `import type` (no duplicated model). The daemon never sends the raw session secrets to the browser beyond what the report already carries (redacted previews); the full session text is only sent for the fields the UI needs to show context, and never a secret's raw value.

## Risks / Trade-offs

- **No auth on a loopback API exposing session content** → bind `127.0.0.1` only, never a public interface; document the single-local-user threat model; offer a configurable random port. A shared/multi-user machine is out of scope for v0.1 and called out.
- **In-memory review state lost on daemon restart** → dispositions are lost, but a re-scan is deterministic (`Finding.id` stable) so the user can redo without corruption; documented. Persistence is a v0.2 option.
- **Git-remote "public" detection is heuristic** (private mirror on a public host, unpushed repo, no remote) → it is a recommendation biasing the picker, NOT a security guarantee; the scan + human gate are the real defenses; documented, with "show all" always available.
- **Huge findings tables (thousands of L3 hits) freeze the UI** → L3 is statistics + sampling (not per-item gating), so the L3 view is a summary + sampled spot-check, not a full per-row render; the blocking (L1/L2 + meta) table — which must be fully actioned — is the bounded, virtualized/paginated list.
- **A blocking meta finding is silently ignorable in the UI** → D5 makes it a first-class blocking row with an acknowledge action, and the gate counts it; a test asserts a `ruleset-compile-error`/`redos-guard` finding keeps the gate locked until acknowledged.
- **Leaking a raw secret to the browser** → the API forwards only the report (redacted previews) and the context fields the UI renders; it never sends a finding's raw secret value. The stamped export is post-redaction.
- **UI/daemon build-order coupling** (daemon serves ui dist) → the daemon resolves the ui dist path at runtime and fails clearly if it is missing / not built, with the build wiring documented.

## Migration Plan

Additive; no migration. Sequencing: (1) daemon package + enumeration/whitelist routes + review lifecycle (scan) with API integration tests through the real engine on fake fixtures; (2) disposition/batch/non-text/gate/preview/export routes; (3) CLI launcher + static serve; (4) ui scaffold (Vite + Tailwind) → picker → findings table + dispositions → batch → non-text → gate banner + signed summary → L3 stats/sampling → export preview, with cheap component tests; (5) `openspec validate`. Rollback = delete the two packages; no external state touched. No publish in this slice.

## Open Questions

- **HTTP library choice** (bare `node:http` handler vs a micro-framework) — leaning minimal to keep deps light; not load-bearing for the API contract.
- **Adopt-or-spawn depth** — v0.1 does "adopt our daemon on the port, else fail clearly"; full negotiation deferred.
- **Whether preview should stream large sessions** — v0.1 returns the whole preview JSON; revisit if session sizes make it heavy.
- **contributorAlias when no username is detected** — the mapper already falls back to `<CONTRIBUTOR>`; confirm slice 4 is happy consuming that neutral value.
- **L3 sampling policy specifics** (how many samples, which categories to prioritize) — a UI concern; v0.1 shows `byCategory` stats + a configurable sample count.
