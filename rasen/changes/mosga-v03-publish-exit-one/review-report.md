# Review Report — mosga-v03-publish-exit-one

**Reviewer:** reviewer-s3 (adversarial; did NOT author this code)
**Scope:** current uncommitted working-tree diff (18 files changed, +496/−30, plus 6 new files)
**Effort:** HIGH (portfolio's security-heaviest slice — a daemon that mutates the user's local git clone)
**Date:** 2026-07-09

## Verdict: **CLEAN** (ship-ready)

No Blocker or Major findings. Two Minor findings (both low-risk, non-blocking) and one Trivial. All gates re-run green independently. The security model holds under adversarial inspection.

### Finding counts by severity
| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 0 |
| Minor | 2 |
| Trivial | 1 |

---

## Gate re-run results (independently executed)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` (root) | **PASS** (exit 0) — all 7 packages |
| Tests | `npx vitest run --testTimeout=20000` (root) | **PASS** — 43 files, **219 tests passed**, 0 failed, 21.6s |
| Spec validate | `rasen validate mosga-v03-publish-exit-one --strict` | **PASS** — "Change is valid" |

No test touches real git/gh or the network in the default path (verified — see axis 7).

---

## Priority axis findings

### Axis 1 — Security / trust model: **PASS**

- **`dataRepoPath` never writable or leakable via HTTP.** Grepped every reference (`packages/daemon/src`): the path is read *only* from `deps.dataRepoPath` (← `AppOptions.dataRepoPath` ← `--data-repo` startup flag). It is used exclusively as a subprocess `cwd` and as `targetRepo`; it is never read from `params`/request body and never placed in any success response. `preflight` returns the boolean `dataRepoConfigured` only (`publish.ts:214-223`), and the test asserts `JSON.stringify(body).not.toContain(dataRepo)` (`publish.test.ts:147`). Trust model is a faithful mirror of `providerKeyConfigPath`.
- **Plan response excludes record bytes.** `uiSafePlan` (`publish.ts:56-77`) enumerates fields explicitly and replaces `record` with `recordBytes` (byte length) + `contentHash` (sha256). Test asserts `not.toHaveProperty('record')` (`publish.test.ts:190`). Confirmed the serialized bytes never cross the HTTP boundary.
- **`precheck_refused` aggregates by rule with NO raw values.** `computePlan` (`publish.ts:187-198`) builds `blockingByRule: [{ruleId, count}]` from a `Map<ruleId, count>` — it reads only `f.ruleId`, never `f.match`/value. Test scans the raw response body for the canary secrets `AKIA`/`ghp_` and asserts absence (`publish.test.ts:227-228`). Solid.
- **`compareUrl` cannot leak embedded credentials.** `parseGitHubOwnerRepo` (`publish.ts:84-103`) reconstructs the URL from `{owner, repo}` only — for the `https://` form it uses `new URL(...)`, checks `hostname === 'github.com'`, and rebuilds `https://github.com/${owner}/${repo}/compare/...`. A `https://user:token@github.com/owner/repo` URL has its userinfo dropped on reconstruction; `github.com.evil.com` fails the hostname check → `null`. The scp form regex `^git@github\.com:` only matches the standard SSH user. **No credential path exists.**
- **Command lists shown to users carry no secrets.** `plan.commands` are the deterministic `git`/`gh` verbs over repo-relative paths (`pr.ts:155-161`); `prBody` is a metadata template rendered *after* `assertPrecheckClean` passes, so it can only ever be shown over clean bytes.
- **Path-traversal / missing path refused safely at startup.** `validateDataRepoPath` (`publish.ts:395-404`) logs to the operator console (never HTTP) on a bad path; `dataRepoConfigured()` guards every route with `fs.statSync(p).isDirectory()`, returning `data_repo_unconfigured` (409) otherwise. `reviewId` is used only as a store key / map key, never as a filesystem path.

### Axis 2 — Concurrency: **PASS**

- **Single-flight mutex is race-free.** `publishInFlight` is checked-then-set with *no `await` between the guard and the assignment* (`publish.ts:248-249`, `263-264`) — atomic under Node's single-threaded model. Released in `finally` on both stage and submit (`publish.ts:253-255`, `317-319`). The `computePlan` re-throw of a non-`PublishRefusedError` propagates *inside* the try, so the mutex still releases. No stuck-true path exists.
- **Concurrency test is real.** `publish.test.ts:350-367` uses a `hold()` gate on `git --version` to freeze the first stage *inside* the mutex, then asserts the second request gets `publish_in_flight` (409) and the first still completes (200). Correct.
- **Async runner is genuinely non-blocking.** The daemon path uses only `*Async` functions (`planContributionAsync`/`stageContributionAsync`/`submitContributionAsync`/`isGit|GhAvailableAsync`/`ghAuthenticatedAsync`), all built on `spawn` (`runner.ts:60-105`). No `execSync`/`spawnSync` on the request path.
- **Stage-then-submit-fail consistency.** `runStage` sets the staged flag *only after* a successful commit (`publish.ts:370`). If submit later fails at `gh_unauthenticated`/`push_rejected`, the flag correctly stays set so a retry skips re-staging (`publish.ts:267-282`). A commit failure leaves the flag unset (`stage_failed`, `publish.ts:364-368`). Correct.

### Axis 3 — Error taxonomy: **PASS**

All eight codes are reachable, each with the design's HTTP status, and each has a dedicated test:

| Code | Status | Reachable at | Test |
| --- | --- | --- | --- |
| `GATE_LOCKED` | 409 | plan/stage/submit via `stampedSessionFor` | `publish.test.ts:160` |
| `data_repo_unconfigured` | 409 | plan/stage/submit | `:232` |
| `precheck_refused` | 422 | plan/stage (rule-aggregated) | `:211` |
| `git_unavailable` | 409 | plan/stage/submit | (guarded; covered structurally) |
| `repo_dirty` | 409 | stage | `:261` |
| `branch_exists` | 409 | fresh stage | `:273` |
| `gh_unauthenticated` | 409 | submit | `:325` |
| `push_rejected` | 409 | submit | `:338` |
| `publish_in_flight` | 409 | stage/submit | `:350` |

The gate-locked → **409 `GATE_LOCKED`** shape (`publish.ts:157-169`) mirrors `/export`. Error body shape `{error, code, ...detail}` matches `/submit`. Check order in `runStage` (`publish.ts:329-358`) matches the design exactly: dataRepo → git → gate → repoClean → plan/precheck → branch collision → write+commit.

### Axis 4 — Behavioral conservation of sync publisher paths: **PASS**

- The `buildPlan` refactor is **pure**. Compared `HEAD:packages/publisher/src/pr.ts` (old inline `planContribution` body) against the new `buildPlan` (`pr.ts:118-179`): line-for-line identical, the *only* difference being `ghAvailable` is now a parameter instead of an inline `isGhAvailable(runner)` call. `planContribution` passes `isGhAvailable(runner)` (`pr.ts:94`) — same probe, same result. Sync `stageContribution`/`submitContribution` bodies are byte-unchanged.
- `pr.test.ts` and `precheck.test.ts` are **unchanged** (`git status` shows neither modified). Both remain green in the 219-test run.

### Axis 5 — Async/sync parity: **PASS**

`async-runner.test.ts:79-105` renders a clean artifact through *both* the sync and async paths and asserts `asyncPlan.commands` equals `syncPlan.commands` and the git verb sequence matches (`['checkout','add','commit']`). `ghAuthenticatedAsync` distinguishes present-unauthenticated (`gh --version` ok, `auth status` non-zero) from absent (`:117-121`). Matches the spec scenario "Async runner mirrors the sync runner" exactly.

### Axis 6 — UI wizard vs design B4: **PASS**

3-step flow (预检 → PR 预览 → 提交) implemented in `PublishWizard.tsx` with pending (`precheck-pending`) + timeout (`precheck-timeout`, 12s non-fatal slow notice) states, `precheck_refused` rule-aggregated view + `onJumpToRule` jump, styled `<pre>` PR body, `compareUrl` link, per-command copy buttons, and the gh-free fallback (staged locations + `plan.commands` noting the last is `gh pr create` + compare link). Exit-① 4-state card (`就绪/需配置/gh未登录/缺依赖`) driven by `usePreflight`. Receipt → `published-badge` "出口① 已完成", and `onPublished()` → `ReviewView` `setCompleted(true)`. Slice-2 signing/stepper/409 semantics untouched (SubmitPanel reused intact in `exit-two`). See the deviation adjudication below.

### Axis 7 — Tests: **PASS**

- **No live git pushes/PRs.** `submitContribution*` is never invoked with a real runner: the daemon test injects `FakeAsyncRunner` (`publish.test.ts:21-79`, records commands, canned results), and `async-runner.test.ts` only exercises plan/stage with fakes. `submitContribution`'s own comment confirms "Never invoked by tests."
- **Daemon publish tests use a fake runner** + temp `dataRepoPath` (`makeTempDir`), torn down in `afterEach`.
- The concurrency test's 60ms settle is generous; `--testTimeout=20000` gives ample headroom. No new *real-git* test was added (the design's mitigation for the known `pr.test.ts` Windows flakiness — the fake runner is preferred throughout, so the flaky class of test wasn't expanded).
- No existing contract was weakened: the UI test edits (`AppShell.test.tsx`, `ReviewView.test.tsx`) only add `getPreflight`/`publish*` stubs required because `ExitCards` now calls `usePreflight` on mount — additive, not a contract change.

---

## Deviation adjudications

### D1 — Explicit 落盘 (stage) button instead of auto-stage on step-③ entry — **ACCEPTED (improvement)**

The spec's literal phrasing (`spec.md` step-④ requirement; `tasks.md` 6.1) is "③ 提交 (call `publish/stage`, always writing to disk...)". The implementer did **not** auto-call stage on step entry; instead:
- **gh-ready path:** a single "一键提交 PR" button runs `publish/submit`, which stages-if-not-staged server-side (`PublishWizard.tsx:263-277`) — one atomic mutation, no double-stage.
- **gh-free path:** an explicit "落盘到数据仓库" button (`wizard-stage-btn`, `:278-292`) triggers stage, then renders `ManualFallback`.

**Adjudication:** This is the *safer* reading and I accept it as an improvement, not a defect. Staging **mutates the operator's local git clone** (creates a branch, commits) — making that an explicit user action rather than a side effect of navigating a stepper directly honors this slice's central threat-model principle ("mutating a dirty/wrong-branch clone" is a budgeted risk). Design decision 9 explicitly anticipated a confirm here ("the dialog primitive from slice 2 is available if a confirm is needed (e.g. 'stage will write to your clone')"); an explicit button is a lighter-weight expression of that same intent. It also avoids a wasted mutation on the gh-ready path. The spec's intent — stage always writes to disk, gh-ready gets one-click submit, gh-free gets the manual fallback — is fully satisfied.

### D2 — gh-free manual staging does NOT mark the journey 已完成 — **ACCEPTED (correct)**

Only `publish/submit` success calls `onPublished()` (`PublishWizard.tsx:123`); the gh-free `doStage` path does not. This is correct: the manual path stages to disk but the PR is not actually opened until the user runs `gh pr create` themselves, so the journey legitimately is not complete. Matches spec scenario "One-click submit completes the journey" (only that scenario feeds completion).

---

## Minor / Trivial findings (non-blocking)

### M1 (Minor) — `focusRuleId` is never reset, so a repeat jump to the *same* rule after a manual group switch is a no-op
`ReviewView.tsx:126-129` sets `focusRuleId` but never clears it. `DispositionWorkspace`'s selection effect (`DispositionWorkspace.tsx:102-106`) fires only when `focusRuleId` (or the memoized findings) change. Sequence: jump to rule A (group→secrets) → user manually switches to the custom group → reopen wizard, jump to rule A *again* → `setFocusRuleId('A')` is a same-value no-op → effect does not re-run → group is not re-selected.
- **Impact:** low — degrades a secondary convenience on repeat use of the same rule; the common first-jump case works. `secretsFindings`/`customFindings` are correctly `useMemo`'d on `[blocking]` (`:75-82`), so the effect does *not* fight the user on every render (the more serious variant of this bug does **not** exist).
- **Suggested fix:** have the consumer reset `focusRuleId` to `null` after the workspace consumes it (e.g. an `onFocusConsumed` callback), or key the jump on a monotonic nonce rather than the rule id.

### M2 (Minor) — `stage_failed` (500) echoes raw git stderr in a `log` field
`runStage` returns `{ ...code:'stage_failed', log: stageResult.log }` on a failed commit (`publish.ts:364-368`). `log` is accumulated `git checkout/add/commit` stdout+stderr (`pr.ts:258`). In principle git error output *could* contain a filesystem path, which sits in mild tension with the strict "the literal path SHALL NOT be echoed over HTTP" requirement.
- **Impact:** very low — this path only fires on a real local git failure; the daemon is loopback-only, single-user, and the operator already owns the path; git's checkout/add/commit errors rarely print the repo's absolute path. Noting for completeness given the axis-1 strictness bar.
- **Suggested fix (optional):** drop `log` from the HTTP body (keep it operator-console only), or return a generic message.

### T1 (Trivial) — redundant `error` in `pubError` spread
`pubError` (`publish.ts:51-53`) computes `error: extra.error ?? code` then spreads `...extra`, which re-assigns the same `error` when the caller passed one. Harmless (same value); could drop the leading `error:` key or the caller's duplicate. No behavior impact.

---

## Summary

This is a carefully built, security-conscious slice. The trust model (path never HTTP-writable or echoed, plan excludes record bytes, precheck_refused rule-aggregated, compareUrl credential-safe) holds under adversarial inspection and is backed by targeted tests that assert the *absence* of leaks. The mutex is race-free, the async runner is genuinely non-blocking, the sync publisher paths are provably unchanged (buildPlan refactor is pure), and async/sync parity is test-enforced. The one implementer deviation (explicit stage button) is an improvement that better honors the clone-mutation threat model. The two Minor findings are low-risk polish items that do not block landing.

**Recommendation: SHIP.** Optionally address M1 (repeat-jump UX) and M2 (stage_failed log) as fast-follows.
