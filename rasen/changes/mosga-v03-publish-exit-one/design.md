# Design — mosga-v03-publish-exit-one

Wire 出口①: daemon publish routes + preflight + `dataRepoPath` config, an async publisher execution path, and the step-④ 出口① wizard. Authoritative: `rasen/office-hours/frontend-ui-redesign.md` §B4 (unusually detailed — honored exactly). Builds on slice 2 (ExitCards placeholder, SettingsPage, `getHealth`). The publisher engine (`planContribution`/`stageContribution`/`submitContribution`/`assertPrecheckClean`/`PublishRefusedError`) already exists and is reused unchanged except for the async runner addition.

## Context (shipped interfaces this slice extends)

- `packages/publisher/src/pr.ts`: `planContribution(session, {targetRepo, targetBranch?, ruleset?, runner?, ...}) → ContributionPlan` (runs `assertPrecheckClean` — throws `PublishRefusedError` on any surviving blocking finding, nothing staged); `stageContribution(plan, opts) → StageResult` (writes files, `git checkout -b`/`add`/`commit`); `submitContribution(plan, opts) → RunPrResult` (git push + `gh pr create`). `ContributionPlan` carries `record` (bytes), `branch`, `targetBranch`, `recordPath`, `provenancePath`, `commitMessage`, `prTitle`, `prBody`, `provenance`, `engine`, `recordCount`, `ghAvailable`, `stagedFiles`, `commands`.
- `packages/publisher/src/runner.ts`: synchronous `CommandRunner` (`run` via `spawnSync`) + `isGitAvailable`/`isGhAvailable`. **Sync — would block the daemon event loop.**
- `packages/daemon/src/app.ts`: `AppOptions` already carries `providerKeyConfigPath` (trusted, startup-only, never HTTP-writable), `userTargets`, `submitTransport` (injected for tests), `now`, `ruleset`. Error helpers `notFound`/`badRequest`; `/export` returns 409 when `!gate.unlocked`; `/submit` maps typed errors to `{error, code, ...}` (422/409/400/500). Routes are registered in the `routes: Route[]` array; handlers may be `async`. `ReviewStore` holds `{session, report, mapper}` per reviewId; `getDefaultRuleset()` compiles once with trusted custom rules.
- `packages/daemon/src/server.ts` `DaemonOptions extends AppOptions`; `cli.ts` parses `--port`/`--no-open` and calls `startDaemon({port})` — **does not yet pass a data-repo**.
- `packages/ui`: `ExitCards.tsx` 出口① is a disabled placeholder; `ReviewView.tsx` owns `completed` (set via `onSubmitted`); `api/client.ts` has `getHealth`; `SettingsPage.tsx` has a daemon-status section.

## Key decisions

1. **New capability `publish-exit-one` (ADDED) + `pr-submission` MODIFIED (1 requirement).** The daemon routes/config/UI are the new capability; the publisher's async-runner widening lives in `pr-submission` (its "gh CLI…manual path" requirement), stated as interface-widened / behaviour-unchanged.
2. **Async runner = the one sanctioned exception to 换容器不换逻辑.** Add `AsyncCommandRunner { runAsync(cmd,args,opts): Promise<RunResult> }` + `defaultAsyncRunner` (`spawn`-based) + `isGitAvailableAsync`/`isGhAvailableAsync`/`ghAuthenticatedAsync` (`gh auth status`), and async `stageContributionAsync`/`submitContributionAsync` that mirror the sync bodies exactly. **Sync `CommandRunner` + sync stage/submit are retained** for the CLI and existing tests. The daemon uses only the async path.
3. **Daemon publish handlers in a new `src/publish.ts`**, registered into `app.ts`'s `routes`. `AppOptions` gains `dataRepoPath?: string` (trust model identical to `providerKeyConfigPath` — startup-only, never HTTP-writable) and `publishRunner?: AsyncCommandRunner` (injected for tests, like `submitTransport`; defaults to `defaultAsyncRunner`). Plan uses `getDefaultRuleset()` + trusted custom rules so the pre-check engine matches the daemon's.
4. **Stage state model** — a `Map<reviewId, { staged: boolean; branch: string }>` in `createApp` closure. `submit` stages first iff no flag. Fresh stage hitting `branch_exists` (no flag) ⇒ stale residue ⇒ `branch_exists` guidance, no auto-clean.
5. **Single in-flight publish mutex** — a closure-scoped `let publishInFlight = false` (a boolean is sufficient for one local user); stage/submit acquire it or return `publish_in_flight` (409); release in `finally`. Plan is read-only (no disk/git mutation beyond the read-only `git remote get-url`) and is not mutexed.
6. **`compareUrl` derivation** in the daemon (plan): `git remote get-url origin` in the clone → normalise SSH (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo(.git)`) forms → `https://github.com/<owner>/<repo>/compare/<targetBranch>...<branch>?expand=1`; `null` when origin is missing or not GitHub. `ContributionPlan` has no remote URL, so this is daemon-derived.
7. **Preflight = the lead's exact 5 fields** `{dataRepoConfigured, gitAvailable, ghAvailable, ghAuthenticated, repoClean}`. `repoClean` = empty `git status --porcelain` in the clone. The literal `dataRepoPath` is **not** returned (consistent with never echoing `providerKeyConfigPath`); the settings row shows configured/not + restart guidance only. (If the design owner later wants the raw path shown, it is a one-field add.)
8. **UI-safe plan subset excludes `record` bytes** — replace with `recordBytes` (byte length of `record.fileContents`) + `contentHash` (existing `computeContentHash` or a sha256 of the bytes). All other enumerated fields pass through; `compareUrl` is appended.
9. **Wizard as inline step-④ panel** (not a modal) so the stepper/journey context stays visible; the `dialog` primitive from slice 2 is available if a confirm is needed (e.g. "stage will write to your clone"). `prBody` renders as a styled `<pre>` (Open Question 3 recommendation — defer a markdown renderer).

## Daemon routes (src/publish.ts)

| Route | Gate-locked | Success | Errors |
| --- | --- | --- | --- |
| `POST /publish/plan` | 409 | UI-safe plan + `compareUrl` + `{recordBytes,contentHash}` | `data_repo_unconfigured`(409), `precheck_refused`(422, rule-aggregated), `git_unavailable`(409) |
| `POST /publish/stage` | 409 | `{staged:true, branch, stagedFiles, recordPath, log?}` | `publish_in_flight`(409), `repo_dirty`(409), `branch_exists`(409), `precheck_refused`(422), `git_unavailable`(409), `data_repo_unconfigured`(409) |
| `POST /publish/submit` | 409 | `{opened:true, receipt-ish}` → completion | `publish_in_flight`, `gh_unauthenticated`(409), `push_rejected`(409), `branch_exists`, `repo_dirty`, + stage errors |
| `GET /publish/preflight` | n/a | `{dataRepoConfigured,gitAvailable,ghAvailable,ghAuthenticated,repoClean}` | — |

Error body shape mirrors `/submit`: `{ error, code, ...detail }`. `precheck_refused` detail = `blockingByRule: [{ruleId, count}]` (aggregate `PublishRefusedError.blockingFindings` by `ruleId`; never raw values). `branch_exists` detail = `{ branch }` + guidance text. `repo_dirty` detail = a short "commit/stash or clean the tree" guidance. Order of checks in stage: mutex → dataRepoConfigured → git available → gate unlocked (409) → repo clean (`git status --porcelain`) → plan/precheck → branch collision → write+commit.

## Async runner (packages/publisher)

```ts
// runner.ts (additions; sync exports unchanged)
export interface AsyncCommandRunner {
  runAsync(command: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<RunResult>;
}
export const defaultAsyncRunner: AsyncCommandRunner;                 // spawn-based, non-blocking
export function isGitAvailableAsync(r?: AsyncCommandRunner): Promise<boolean>;
export function isGhAvailableAsync(r?: AsyncCommandRunner): Promise<boolean>;
export function ghAuthenticatedAsync(r?: AsyncCommandRunner): Promise<boolean>;  // `gh auth status`
// pr.ts (additions; sync planContribution/stageContribution/submitContribution unchanged)
export function stageContributionAsync(plan, opts & {asyncRunner}): Promise<StageResult>;
export function submitContributionAsync(plan, opts & {asyncRunner}): Promise<RunPrResult>;
```
`planContribution` stays sync (in-memory + `isGhAvailable`); the daemon calls it directly (fast, no subprocess except the read-only `git remote`/`isGhAvailable` — acceptable, or offer `planContributionAsync` if event-loop purity is wanted for the gh/remote probe; **recommend a small `planContributionAsync` too** so `ghAvailable` + `compareUrl` probes are non-blocking). Async bodies are line-for-line the sync bodies with `await runner.runAsync` — same steps, same short-circuits.

## dataRepoPath config + CLI

- `AppOptions.dataRepoPath?: string`; `DaemonOptions` inherits it. Validate at startup: if set, resolve + check it exists and is a directory (a git clone); a bad path is a startup config error to the operator console (like `loadTrustedCustomRules`), NOT an HTTP error.
- `cli.ts`: parse `--data-repo <path>` / `--data-repo=<path>` → `startDaemon({ port, dataRepoPath })`. Extend `HELP`. The desktop shell can pass it through later; not required this slice.

## UI

- `api/types.ts`: `PublishPreflight`, `PublishPlan` (the UI-safe subset), `PublishError` (`{error, code, ...}`), `PublishStageResult`, `PublishSubmitResult`.
- `api/client.ts`: `getPreflight()` (GET), `publishPlan(reviewId)`, `publishStage(reviewId)`, `publishSubmit(reviewId)` — each returning `{ok:true,...} | {ok:false, code, error, ...}` like `exportReview`/`submit`. Additive; add stubs to the test fake/empty clients.
- `src/lib/usePreflight.ts`: fetch preflight, expose `{ state: '就绪'|'需配置'|'gh未登录'|'缺依赖', flags }` derived per decision 7.
- `src/components/journey/PublishWizard.tsx`: the 3-step wizard (预检 → 预览 → 提交) with pending/timeout states, `precheck_refused` rule-aggregated view + "回到②" jump (call a prop `onJumpToRule(ruleId)` that `ReviewView` maps to step ② + the rule's group), styled `<pre>` PR body, per-command copy buttons, gh-free fallback (staged locations + `plan.commands` + `git push` + `compareUrl`). On submit success call `onPublished()` → `ReviewView` sets `completed`.
- `ExitCards.tsx`: replace the disabled 出口① CTA with the preflight-driven 4-state card; 就绪 opens `PublishWizard`. Keep `data-testid="exit-one"`/add `exit-one-cta`.
- `SettingsPage.tsx`: add a "数据仓库" read-only row (configured/not from preflight `dataRepoConfigured` + restart guidance).

## Testing (determinism first; addresses pr.test.ts flakiness)

- **Daemon publish tests inject a fake `AsyncCommandRunner`** (records commands; returns configured git/gh presence + `git status`/`remote`/auth outputs) via `AppOptions.publishRunner` + a temp `dataRepoPath` — **no real git/gh, no network**. Cover: plan 409 while locked; plan UI-safe subset excludes record bytes + has `compareUrl`; `precheck_refused` rule-aggregated (inject a ruleset/session that fails the pre-check); stage sets staged flag; submit stages-if-not-staged; `branch_exists` on fresh stage → guidance, no delete; `repo_dirty`; `gh_unauthenticated`; `push_rejected`; `publish_in_flight`; preflight 5 flags.
- **Publisher async-runner tests** use a fake `AsyncCommandRunner` (mirror the existing `FakeRunner` pattern in `pr.test.ts`) — assert the async path issues the same command sequence as sync, and `ghAuthenticatedAsync` distinguishes present-unauthenticated.
- **Real-git tests**: any test that shells to real git runs **serially** (vitest `describe.sequential` / a `--no-file-parallelism`-friendly isolation) with a **raised timeout**, and **skips when `isGitAvailable()` is false** — the documented mitigation for the known `pr.test.ts` Windows subprocess-contention timeout flakiness. Prefer the fake runner and avoid adding new real-git tests where a fake suffices.
- **UI wizard tests**: fake client returning canned plan/preflight/stage/submit; assert the 4 card states, the 3-step flow, `precheck_refused` → jump callback, and the gh-free command/compare fallback rendering. Non-text/gate/disposition contracts elsewhere remain untouched.

## Risks / mitigations

- **Daemon event-loop blocking on git/gh** → the async runner + `spawn`; the sync path is never used by the daemon.
- **Mutating a dirty/wrong-branch/mid-rebase clone** → preflight `repoClean` gate + `repo_dirty`/`branch_exists` typed errors + no auto-cleanup; the wizard surfaces guidance. Budget the error paths ≈ the happy path.
- **Deterministic branch retry collision** → `branch_exists` names the branch + guidance; the in-memory staged flag distinguishes "our current attempt" from stale residue.
- **Leaking a filesystem path / key over HTTP** → `dataRepoPath` never returned; preflight is booleans only; `precheck_refused` is rule-aggregated, never raw values; the plan excludes record bytes.
- **Test flakiness** → fake async runner by default; real-git tests serial + raised timeout + git-availability guard.
- **Scope creep** → no CI/community-repo side, no receipt persistence/历史, no HuggingFace sync, no markdown renderer (styled `<pre>` per Open Question 3).
