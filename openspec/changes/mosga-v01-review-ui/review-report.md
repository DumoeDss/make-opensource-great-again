# Adversarial Review — mosga-v01-review-ui

**Reviewer:** reviewer-review-ui (did not author this code)
**Date:** 2026-07-07
**Scope:** `packages/daemon/**`, `packages/ui/**`, root wiring (`package.json`, `vitest.config.ts`) vs
`openspec/changes/mosga-v01-review-ui/{proposal,design,specs,tasks}` and the fixed cross-slice
contracts in `openspec/changes/mosga-v01/planning-context.md` ("Planner findings — review-ui").

## Verdict: NEEDS-FIX

The human-confirmation **gate is CLEAN** — I could not construct any sequence that yields a stamped
`SanitizedSession` while findings/non-text items are undispositioned. One **Major** information-disclosure
exists on a different surface (`customRulesPath` arbitrary file read), plus minor loopback/robustness notes.

| Severity | Count |
|----------|-------|
| Blocker  | 0 |
| Major    | 1 |
| Minor    | 3 |
| Trivial  | 1 |

## Gates run (real results)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npm run typecheck` | PASS — all 5 workspaces clean (contracts, session-readers, sanitizer, ui, daemon) |
| Build | `npm run build` | PASS — ui `vite build` produced `packages/ui/dist/` (index.html + assets); daemon `tsup` built cli+index |
| Tests | `npx vitest run` | PASS — **22 files, 93 tests passed** (matches the expected 93) |

Live adversarial probe (built daemon on an ephemeral loopback port) — see per-finding evidence below.

---

## Gate-bypass hunting (primary Blocker surface) — CLEAN

Verified every pre-registered bypass attempt fails safe:

- **Stamped-while-locked is impossible.** `applyDispositions` recomputes the gate *fresh* from the actual
  arrays — `const gate = computeGate(report.findings, report.nonTextItems)` (`packages/sanitizer/src/apply.ts:180`)
  — it never trusts a stored `report.gate`. Stamping happens ONLY inside `if (gate.unlocked)`
  (`apply.ts:213`). The export route returns 409 when `!result.gate.unlocked` and otherwise returns the
  session that was stamped under that same unlocked check (`packages/daemon/src/app.ts:300-308`). A 200
  from `/export` therefore always carries a stamped session; a locked gate always 409s. Confirmed live:
  `/export` on a fresh review → `409 {gate.unlocked:false, session:undefined}`; after dispositioning all
  blocking + non-text → `200 meta.sanitized:true` (also asserted by `export.test.ts:29`).
- **`computeGate` counts every blocking kind** including `ruleset-compile-error` / `redos-guard`
  (`scan.ts:490` filters on `f.blocking`, no rule-id filtering); `disposition.test.ts:122` proves a pending
  `ruleset-compile-error` keeps the gate locked until acknowledged.
- **Disposition of a non-existent finding / non-text id → 404** before any mutation
  (`app.ts:224`, `app.ts:267`). Confirmed live: unknown review/finding → 404.
- **Invalid disposition value → 400, no mutation** (`app.ts:222-223`, verified unchanged report by
  `disposition.test.ts:107`).
- **Second reviewId of the same session** starts fresh (independent in-memory state; `ReviewStore.create`
  always mints a new `randomUUID` and re-scans → all findings pending). No unlock inheritance.
- **Re-scan** = a new review id (there is no re-scan-in-place route), so no partial-state reset incoherence.
- **Concurrent / double dispositions** cannot falsely unlock: `setReport` replaces the held report wholesale
  (`reviews.ts:54`), so a lost update can only DROP an edit (gate stays *more* locked), and `/export`
  re-derives the gate at call time. Double-dispositioning is an idempotent overwrite.
- **Batch cannot clear meta findings sideways:** `batchByType` matches `f.category` (`apply.ts:52`); meta
  findings have no category, so batch-by-type can't touch them. `batchByRule` on `ruleset-compile-error`
  with `allow` *is* a legitimate human acknowledge (one-click), not a bypass — it still requires an explicit
  disposition action per the gate's semantics.

## UI gate honesty — CLEAN

The export button's enabled-state derives from daemon truth, not a client-side computation:
`canExport = gate.unlocked && signed && !exporting` where `gate` is `report.gate` returned by the daemon
(`packages/ui/src/components/GateBanner.tsx:27`, fed from `ReviewView` state that is only ever replaced by
daemon responses, `ReviewView.tsx:64-67`). Even if a tampered client forced the button on, `/export`
re-checks server-side and 409s. A report change that re-locks the gate also drops a stale signature
(`ReviewView.tsx:67`). All blocking finding kinds render (no filtering: `blockingFindings` = `f.blocking`,
`ui/src/lib/findings.ts:33`); meta findings get an acknowledge/allow affordance (`FindingsTable.tsx:33`);
`rulesetWarnings[]` surface as a banner.

## Non-text ⚠ flow — CLEAN

Every `nonTextItem` renders in a per-item confirm list with keep/remove (`NonTextList.tsx`), including items
resolved onto tool_use messages (rendered at their `messageIndex`). `keep`/`remove` round-trip to the
sanitizer: `remove` deletes `msg.nonTextContent` at export (`apply.ts:206-211`), `keep` retains it;
`nonTextPending` gates until each is dispositioned (`export.test.ts` exercises the full round-trip).

## Loopback binding & static serving — CLEAN (with a DNS-rebinding note, see M-2)

- Host is hard-wired: `server.listen(port, LOOPBACK_HOST, …)` with `LOOPBACK_HOST='127.0.0.1'`
  (`server.ts:36`, :10). Port is configurable (flag/`MOSGA_PORT`/default 8899) but the interface is not.
  No env/config path binds a non-loopback interface.
- **Path traversal out of the ui dist is contained.** `serveUi` rejects anything resolving outside dist via
  `resolved.startsWith(distResolved + path.sep)` (`staticUi.ts:66`), and `path.resolve` does not decode
  `%2e`/`%2f`, so encoded traversal stays a literal in-dist segment. Live probe of
  `/ui/../../../../etc/passwd`, `/ui/%2e%2e/%2e%2e/package.json`, `/ui/..%2f..%2fpackage.json`,
  `/ui/....//package.json`, `/ui/assets/%2e%2e/%2e%2e/package.json` → **no file leaked** (either 404, or a
  harmless SPA `index.html` fallback for encoded-slash paths). `package.json`/`/etc/passwd` contents never
  appeared.

## Contract fidelity — CLEAN

Routes, status codes, and the 409-with-gate export shape match the planner's fixed contract
(`planning-context.md:183-192`) exactly: `GET /api/sources`, `.../projects` (with
`{gitRemote,recommended,recommendReason}`, show-all opt-in), `.../sessions`; `POST /api/reviews` →
`{reviewId,report,rulesetWarnings}`; disposition/batch/nontext/gate routes; `POST .../preview`;
`POST .../export` → stamped session or 409+gate. Gate model `{blockingTotal,blockingPending,nonTextPending,
unlocked}` with `unlocked = blockingPending===0 && nonTextPending===0` (`scan.ts:493-498`). Slice 4 can
consume `/export` as specified.

## Fixtures — CLEAN

Daemon test fixtures are hand-crafted fake-only: `FAKE_AWS_KEY='AKIAFAKEFAKEFAKE1234'`,
`FAKE_GITHUB_PAT='ghp_aBcD…'` — structurally valid, obviously non-functional canaries
(`__tests__/_helpers.ts:12-13`). Sessions/git remotes are written into temp dirs; no real session data.

---

## Findings

### [Major] Arbitrary file read / secret disclosure via `customRulesPath` error echo

**File:** `packages/daemon/src/app.ts:83-89` (`rulesetFor`) + `:164-169` (create-review error handling)

`POST /api/reviews` accepts an unvalidated `customRulesPath` (`app.ts:60`) and does
`fs.readFileSync(customRulesPath,'utf-8')` then `JSON.parse` (`app.ts:85-86`). On a parse failure the raw
error is returned to the client: `return badRequest(\`could not load custom rules: ${(err).message}\`)`
(`app.ts:168`). Node's `JSON.parse` error message **echoes the beginning of the file's bytes**, so any file
the daemon process can read is partially disclosed in the 400 response body.

**Confirmed live** — pointing `customRulesPath` at a planted `SENSITIVE.txt`:
```
STATUS 400
BODY {"error":"could not load custom rules: Unexpected token 'A', \"AWS_SECRET\"... is not valid JSON"}
```
The response leaked `AWS_SECRET` — the first bytes of an arbitrary file outside the session tree.

Why it matters for THIS product: it is an arbitrary-file-read information disclosure that directly
contradicts design D8 ("The daemon never sends the raw session secrets to the browser … never a finding's
raw secret value"). It reads files *outside* "the session under review," which exceeds the D2 threat model's
accepted scope, and combined with the unvalidated Host header (M-2) it is reachable from a website the user
visits (DNS rebinding), turning a local tool into a remote partial-file-read primitive. It is NOT a gate
bypass (no stamped session escapes), so it is Major, not Blocker.

**Suggested fix:** Do not echo the underlying parse error — return a generic
`badRequest('custom rules file is not valid JSON')`. Additionally, since the UI never sends
`customRulesPath` (no client method exists), consider confining it to a known rules directory or dropping the
param from the v0.1 API surface; if kept (it is in the cross-slice contract), at minimum stop leaking file
bytes and document that it performs a raw filesystem read.

### [Minor] Host header not validated — DNS-rebinding exposure

**File:** `packages/daemon/src/app.ts:319-320` (origin is a fixed loopback string; incoming `Host` is never checked)

The daemon has no auth (documented) and does not validate the request `Host` header. Live probe:
`GET /api/health` with `Host: evil.example.com` → **200**. A website the user visits could rebind a hostname
to `127.0.0.1:8899` and, with no auth and no Host/Origin check, drive the review API cross-origin — reading
session content and (via the Major above) arbitrary file snippets. This was pre-registered as
"acceptable for v0.1 loopback but note it," so it is Minor — but it is the multiplier that makes the Major
remotely reachable.

**Suggested fix (v0.2, cheap):** reject requests whose `Host` is not `127.0.0.1[:port]`/`localhost[:port]`;
add DNS-rebinding to the README threat model (currently unmentioned).

### [Minor] `/preview` returns raw text of still-pending findings

**File:** `packages/daemon/src/app.ts:280-291`

`applyDispositions` only rewrites `replace`/`delete` findings (`apply.ts:129`); a still-`pending` finding's
raw text is left intact. The preview endpoint returns the whole partially-applied `session`, so its body can
contain un-redacted secret text for pending findings — again contradicting D8's "never sends a finding's raw
secret value." The shipped UI never calls preview (there is no `preview` method on `ApiClient`), so this is
an API-only exposure on the same loopback/rebinding channel as M-2.

**Suggested fix:** either drop the preview endpoint for v0.1 (unused by the UI) or redact pending-finding
spans in the preview session before returning it.

### [Minor] Unbounded review-store growth (no eviction)

**File:** `packages/daemon/src/reviews.ts:34`

`ReviewStore` holds `{session, report, mapper}` per review in a `Map` that is never pruned. Every
`POST /api/reviews` retains a full session+report+mapper for the daemon's lifetime; a long-lived daemon that
scans many sessions grows without bound. Low impact for a single-user tool, but there is no cap, TTL, LRU, or
delete-review route.

**Suggested fix:** add a max-entries LRU or a `DELETE /api/reviews/:id`, and/or evict on a new review.

### [Trivial] Concurrent dispositions are last-write-wins

**File:** `packages/daemon/src/reviews.ts:54` (`setReport` replaces the held report wholesale)

Two in-flight disposition requests both read the same base report and the later write clobbers the earlier
edit. No security impact (a lost edit only keeps the gate *more* locked, and `/export` re-derives the gate),
but a rapid double-action could silently drop a disposition and desync the visible counts. Acceptable for
single-user v0.1; noted for completeness.

---

## Spec axis (proposal / tasks / specs)

All tasks 1.1–9.2 are implemented and match the specs: loopback server + threat-model README (1.x),
enumeration + git-remote whitelist (2.x), stateful review holding the mapper (3.x), disposition/batch/gate
routes counting all blocking kinds (4.x), preview + gated 409 export (5.x), same-origin static serve + CLI
adopt-or-fail (6.x), UI scaffold + typed client (7.x), full review workflow incl. meta acknowledge / L3
stats-only / signed summary / export preview (8.x), and green typecheck/build/test + `openspec validate`
(9.x). No scope creep observed; the two shipped upstream packages are consumed unchanged. The only spec-vs-
code gaps are the D8 contradictions surfaced above (M-1, and the preview raw-text case M-3).

---

# Round 1 re-review

Re-reviewed ONLY the delta (`packages/daemon/src/app.ts`, `packages/daemon/src/reviews.ts`,
`packages/daemon/README.md`, new `packages/daemon/src/__tests__/security.test.ts`) against the round-0
findings. **Verdict: CLEAN.** All four actionable findings are resolved; no new findings.

## Gates run (real results)

| Gate | Result |
|------|--------|
| `npm run typecheck` | PASS — 5 workspaces clean |
| `npm run build` | PASS — ui dist rebuilt, daemon cli+index rebuilt |
| `npx vitest run` | PASS — **23 files, 99 tests** (matches expected 99; +6 in `security.test.ts`) |

Plus a fresh live adversarial probe against the rebuilt daemon (results inline below).

## Per-finding status

### [Major] Arbitrary file read via `customRulesPath` — FIXED (surface removed)

`customRulesPath` is gone from `CreateReviewBody` (`app.ts:70-74`); zod `.object()` **strips** unknown keys,
and the handler destructures only `{sourceId, projectKey, sessionId}` (`app.ts:164`). The per-request
`rulesetFor()` + error-echoing try/catch are deleted. Custom rules now load ONCE at startup from a trusted
`AppOptions.customRulesPath` via `loadTrustedCustomRules()` (`app.ts:419-424`), whose read/parse is called
inside `createApp` before `server.listen` — a throw there is a startup config error to the operator console,
never an HTTP response. **No request path reaches an `fs` read with attacker-controlled input.**

Live-confirmed on the built daemon: sending `customRulesPath` = an absolute canary file, a `../../../../etc/passwd`
traversal, and a forward-slash canary path all returned **201** (review created normally) with **no canary
bytes** in any response (`leak=false` for all three). Also covered by `security.test.ts:58`.

Note for the planner: the fixed cross-slice contract in `planning-context.md:186` listed `customRulesPath?`
as an accepted create-review field. Dropping it from the request body is a deliberate, correct security
deviation (the capability moved to trusted server config; slice 4 consumes `/export`, not this request
shape). Recommend updating the planning-context contract note so slice 4 doesn't expect the param.

### [Minor] M-2 Host / DNS-rebinding — FIXED

`dispatch()` rejects a non-loopback `Host` with 403 **before** routing, static serving, or body reads
(`app.ts:341-344`) — the check is at the top of the single dispatch entry point, not skippable.
`isLoopbackHost()` (`app.ts:402-411`) strips the port, handles bracketed IPv6, lowercases, and allowlists
`127.0.0.1`/`localhost`/`::1`/`[::1]`; absent Host → allowed (documented: socket is already loopback-bound
and no attacker origin is asserted).

Live-confirmed bypass matrix: `evil.example.com` → 403, `127.0.0.1.evil.com` (rebinding-suffix) → 403,
`evil.com:1234` → 403; `127.0.0.1:P` → 200, `localhost:P` → 200, `LOCALHOST:P` (case) → 200, `[::1]:P` → 200,
absent Host → 200. Only `req.headers.host` is consulted (no `X-Forwarded-Host` trust). Matches
`security.test.ts:87,102`. (Trivial aside: an *unbracketed* `::1` Host would 403 due to port-split — stricter,
not a bypass, and non-conformant per RFC 7230; no action needed.)

### [Minor] M-3 `/preview` leaked pending raw text — FIXED

`redactPendingBlocking()` (`app.ts:432-439`) rewrites every still-`pending` **blocking** finding to
`replace` with a neutral `<PENDING:ruleId>` marker before the preview apply; `allow`/`replace`/`delete`
keep the human's decision. I verified the dangerous case directly: a review with pending blocking findings
and NO non-text items makes the redacted preview report compute as internally "unlocked," so
`applyDispositions` would stamp — but the handler masks `meta` back to the source envelope
(`app.ts:302`), hardcodes `stamped:false`, and reports the gate from the **real** `state.report`
(`app.ts:303`). Live result: `stamped=false, meta.sanitized=false, gate.unlocked=false,
leakKey=false (FAKE AWS key absent), hasPENDING=true, contributorAlias="<CONTRIBUTOR>"` — no raw secret and
no stamped envelope escape. Redaction cannot be "skipped" by a crafted disposition: only an explicit human
`allow` retains raw text, which is the intended keep-decision (and would export identically). `rulesetMeta`
findings inject nothing (apply ignores their zero-width span; `readField` returns undefined). Matches
`security.test.ts:113`. `primaryContributorAlias()` is a pure read (`pseudonym.ts:52-58`), so the preview's
internal apply has no side effect on the mapper used by a later real export.

*(Observation, not a defect: the preview correctness now depends on the `meta:{...state.session.meta}` mask
+ hardcoded `stamped:false`. It is correct and test-covered today, but a future refactor that drops the mask
could regress it. A stronger design would force-unstamp inside apply or not reuse apply's stamping for
preview. Non-blocking.)*

### [Minor] M-4 Unbounded review store — FIXED

`ReviewStore` takes a `maxReviews` cap (default 50, `reviews.ts:34,42`), evicts LRU after each `create`
(`reviews.ts:56,98-104`), and `get`/`setReport` `touch()` (re-insert) to keep active reviews warm
(`reviews.ts:62,79`). **No use-after-evict:** handlers grab `state` via `store.get` and run synchronously to
completion (no `await` between get and response), and eviction only runs inside `create`, so a review cannot
be evicted mid-handler; a subsequent request for an evicted review just gets 404 (re-scan is deterministic).
A concurrent export is therefore never broken by eviction. LRU correctness covered by `security.test.ts:127`
(cap 2: touched `first` survives, LRU `second` is evicted, `third` present).

### [Trivial] Concurrent last-write-wins — DOCUMENTED

Now documented in the `setReport` doc comment (`reviews.ts:66-74`) with the safe-direction reasoning. No code
change needed; accepted for single-user v0.1.

## Gate re-confirmation (unchanged, still CLEAN)

The export handler (`app.ts:311-327`) is byte-for-byte the same gating logic: `applyDispositions` on the
**real** `state.report`, 409 when `!result.gate.unlocked`, stamped session only on the unlocked branch. The
preview change touches only a preview-local redacted report and never the stored state (`redactPendingBlocking`
and `applyDispositions` are non-mutating; session is `structuredClone`d). Live: `EXPORT_LOCKED → 409`,
`EXPORT_UNLOCKED → meta.sanitized:true` with the raw AWS key absent (replaced). No stamped-while-locked path
exists.

## Final verdict: CLEAN
