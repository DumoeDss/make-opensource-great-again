# Tasks — mosga-v03-publish-exit-one

Ordered, individually completable. Wires 出口①: publisher async runner + daemon publish routes/config + step-④ wizard. Capabilities: `publish-exit-one` (new) + `pr-submission` (modified). Reuse the existing publisher engine unchanged except the async additions. Fixtures are hand-crafted fake data; NO real git/gh in the default test path. Do NOT touch archived artifacts.

## 1. Publisher async command runner

- [x] 1.1 In `packages/publisher/src/runner.ts` add `AsyncCommandRunner { runAsync(cmd,args,opts): Promise<RunResult> }` + `defaultAsyncRunner` (`spawn`-based, non-blocking, same result mapping as `defaultRunner`). Keep the sync `CommandRunner`/`defaultRunner` unchanged.
- [x] 1.2 Add `isGitAvailableAsync`, `isGhAvailableAsync`, and `ghAuthenticatedAsync` (`gh auth status`, code 0 = authenticated). Export all from `index.ts`.
- [x] 1.3 In `pr.ts` add `stageContributionAsync(plan, opts)` and `submitContributionAsync(plan, opts)` mirroring the sync bodies line-for-line with `await asyncRunner.runAsync`; add `planContributionAsync` so the `ghAvailable` + (new) `compareUrl` probes are non-blocking. Keep the sync functions unchanged. Export from `index.ts`.
- [x] 1.4 Vitest (fake `AsyncCommandRunner`, no real git/gh): the async path issues the same command sequence as the sync path for a clean artifact; `ghAuthenticatedAsync` distinguishes present-unauthenticated (gh `--version` ok, `auth status` non-zero) from absent.

## 2. Daemon config + preflight

- [x] 2.1 Add `dataRepoPath?: string` and `publishRunner?: AsyncCommandRunner` to `AppOptions` (trust model of `providerKeyConfigPath`: startup-only, never HTTP-writable). Validate `dataRepoPath` at startup (exists + is a directory); a bad path is an operator console error, not an HTTP error.
- [x] 2.2 Add `--data-repo <path>` / `--data-repo=<path>` to `cli.ts` `parseArgs` → `startDaemon({ port, dataRepoPath })`; extend `HELP`.
- [x] 2.3 Implement `GET /api/publish/preflight` (in a new `packages/daemon/src/publish.ts`, registered in `app.ts`): return `{ dataRepoConfigured, gitAvailable, ghAvailable, ghAuthenticated, repoClean }` using the injected async runner (`git/gh --version`, `gh auth status`, `git status --porcelain` in the clone) + `dataRepoPath` presence. Do NOT return the literal path.

## 3. Daemon publish/plan

- [x] 3.1 Implement `POST /api/reviews/:reviewId/publish/plan`: 409 when the gate is locked (mirror `/export`); `data_repo_unconfigured`(409) when no data repo; run `planContributionAsync` with the review's stamped session, `getDefaultRuleset()` + trusted custom rules, `targetRepo: dataRepoPath`. Return the UI-safe subset (`branch,targetBranch,recordPath,provenancePath,prTitle,prBody,commitMessage,recordCount,ghAvailable,stagedFiles,commands,provenance,engine`) + `recordBytes` + `contentHash`, EXCLUDING record bytes.
- [x] 3.2 Derive `compareUrl`: `git remote get-url origin` in the clone → normalise SSH/HTTPS GitHub forms → `.../compare/<targetBranch>...<branch>?expand=1`; `null` when absent/non-GitHub. Append to the plan response.
- [x] 3.3 Map `PublishRefusedError` → `precheck_refused`(422) with `blockingByRule: [{ruleId,count}]` (aggregate by ruleId, NO raw values); `git` absent → `git_unavailable`(409).

## 4. Daemon publish/stage + submit + state model

- [x] 4.1 Add an in-memory per-review stage state (`Map<reviewId,{staged,branch}>`) and a single `publishInFlight` mutex in the `createApp` closure.
- [x] 4.2 Implement `POST /api/reviews/:reviewId/publish/stage`: acquire mutex (else `publish_in_flight` 409); checks in order — dataRepoConfigured → git available → gate unlocked (409) → `repoClean` (else `repo_dirty` 409) → plan/precheck (`precheck_refused` 422) → branch collision (`branch_exists` 409 with existing branch name + guidance, NO auto-clean) → `stageContributionAsync`. On success set the staged flag + branch; release mutex in `finally`.
- [x] 4.3 Implement `POST /api/reviews/:reviewId/publish/submit`: mutex; stage-if-not-staged (per the flag); `ghAuthenticatedAsync` false while gh present → `gh_unauthenticated`(409); `submitContributionAsync`; push non-zero → `push_rejected`(409). Return the opened/receipt result for the completion state.
- [x] 4.4 Vitest (fake async runner + temp `dataRepoPath`, no real git/gh): plan 409 locked; plan subset excludes record bytes + has `compareUrl`; `precheck_refused` rule-aggregated; stage sets flag; submit stages-if-not-staged; `branch_exists` fresh stage → guidance + no delete; `repo_dirty`; `gh_unauthenticated`; `push_rejected`; `publish_in_flight`; preflight 5 flags. Mark any real-git test serial + raised timeout + skip when `isGitAvailable()` is false.

## 5. UI client + preflight hook

- [x] 5.1 Add `PublishPreflight`, `PublishPlan` (UI-safe subset), `PublishError`, `PublishStageResult`, `PublishSubmitResult` to `api/types.ts`.
- [x] 5.2 Add `getPreflight()`, `publishPlan(reviewId)`, `publishStage(reviewId)`, `publishSubmit(reviewId)` to `ApiClient` + `apiClient` (result-union style like `exportReview`/`submit`). Add stubs to the test fake/empty clients.
- [x] 5.3 Create `src/lib/usePreflight.ts` deriving the exit-① card state (`就绪`/`需配置`/`gh未登录`/`缺依赖`) from the 5 flags.

## 6. UI wizard + card + settings

- [x] 6.1 Create `src/components/journey/PublishWizard.tsx`: 3 steps — 预检 (`publishPlan`, pending + timeout states; `precheck_refused` → rule-aggregated view + `onJumpToRule`) → PR 预览 (`prTitle`, `prBody` as styled `<pre>`, `stagedFiles`, branch, `compareUrl`) → 提交 (`publishStage` always; `ghAvailable && ghAuthenticated` → one-click `publishSubmit`; else staged locations + `plan.commands` (note last is `gh pr create`) + `git push` + `compareUrl` fallback + per-command copy buttons). Call `onPublished()` on submit success.
- [x] 6.2 Update `ExitCards.tsx`: replace the disabled 出口① placeholder with the preflight-driven 4-state card; 就绪 opens `PublishWizard`; keep `exit-one`/`exit-one-cta` testids. Wire `onJumpToRule` + `onPublished` up to `ReviewView` (jump → step ② + rule group; published → `completed`).
- [x] 6.3 Update `SettingsPage.tsx`: add a read-only 数据仓库 row (configured/not from preflight `dataRepoConfigured` + "--data-repo <path> 重启" guidance); do not print the raw path.
- [x] 6.4 Vitest (fake client with canned preflight/plan/stage/submit): the 4 card states; the 3-step flow; `precheck_refused` → jump callback fires; gh-free path renders commands + compare fallback; submit success sets completion. Existing disposition/gate/signing tests stay green.

## 7. Validation

- [x] 7.1 Run `npm run typecheck` (root) — publisher + daemon + ui; fix until green.
- [x] 7.2 Run `npm run build` (root) — all packages incl. ui; fix until green.
- [x] 7.3 Run root `npm test` (`vitest run`) — all suites green; no test touches real session data, and no new test opens a real external PR or requires real git in the default path.
- [x] 7.4 Run `node "E:\AI\ChatAI\Agents\VibeCodingProjects\workflow\Reference\OpenSpec-code\bin\rasen.js" validate mosga-v03-publish-exit-one --strict` and fix until it passes.
