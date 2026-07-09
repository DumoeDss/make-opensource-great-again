## Why

出口①「公开数据集」is the README's core promise — safely contributing a sanitized session as a public dataset PR — and the whole `@mosga/publisher` engine for it already exists (`planContribution` / `stageContribution` / `submitContribution` with a mandatory pre-check). But nothing wires it: there is no daemon route, no config, and (after slice 2) the step-④ 出口① card is a readiness placeholder with a disabled CTA. This slice closes that gap: daemon publish routes + preflight, a `--data-repo` config on the trusted side, an async execution path so git/gh never block the daemon event loop, and the step-④ 出口① three-step wizard (预检 → PR 预览 → 提交). It is the last slice of the portfolio and the one where "the interface stops at a pile of JSON" finally becomes a working PR flow.

The hidden weight here is that the daemon **mutates the user's local git clone** (writes files, creates a deterministic branch, commits, pushes, opens a PR via `gh`). The unhappy paths — dirty tree, wrong branch, mid-rebase, deterministic-branch retry collisions, `gh` present-but-unauthenticated, push rejected — are budgeted at roughly the happy path's weight, mirroring the existing `/submit` error discipline (`ConsentError`/`NotStamped`/`KeyNotConfigured` → typed codes).

## What Changes

- **Daemon publish routes** (gate-locked → 409, mirroring `/export` and `/submit`):
  - `POST /api/reviews/:reviewId/publish/plan` — export + mandatory pre-check + plan, purely in memory (no disk, no git except the read-only `compareUrl` derivation). Returns the **UI-safe subset** of `ContributionPlan` — `branch`, `targetBranch`, `recordPath`, `provenancePath`, `prTitle`, `prBody`, `commitMessage`, `recordCount`, `ghAvailable`, `stagedFiles`, `commands`, `provenance`, `engine` — plus daemon-derived `compareUrl` (from `git remote get-url origin` in the clone → a GitHub compare URL) and a record summary (`recordBytes` size + `contentHash`); it **excludes** the serialized `record` bytes.
  - `POST /api/reviews/:reviewId/publish/stage` — write record + provenance sidecar + PR-body file, create the branch, `git add`, `git commit`. Sets the in-memory staged flag + branch. gh-absent users stop here (manual path).
  - `POST /api/reviews/:reviewId/publish/submit` — stage-if-not-staged (per the in-memory flag) + `submitContribution` (push + `gh pr create`).
  - `GET /api/publish/preflight` — `{ dataRepoConfigured, gitAvailable, ghAvailable, ghAuthenticated, repoClean }`, driving the exit-① card's four states.
- **Error taxonomy to the `/submit` standard** (typed `code` + guidance): `precheck_refused` (rule-aggregated finding counts, no raw values), `repo_dirty`, `branch_exists` (deterministic branch collision — includes the existing branch name + "delete-or-continue" guidance; **no auto-cleanup**), `gh_unauthenticated` (`gh auth status` probe), `push_rejected`, plus `data_repo_unconfigured` / `git_unavailable` / `publish_in_flight`.
- **`dataRepoPath` config** — added to `AppOptions` with the **exact trust model of `providerKeyConfigPath`**: server-side at startup only, **never writable via HTTP**. New `mosga ui --data-repo <path>` CLI flag. The settings page shows a read-only configured / not-configured status + the "restart with `--data-repo <path>`" guidance (the literal path is not echoed over HTTP, consistent with the key-config trust model).
- **Async execution in `@mosga/publisher`** — the current `CommandRunner` is synchronous (`spawnSync`), which would block the daemon event loop across git/gh subprocesses. Add an **async `CommandRunner` variant** (`runAsync` via `spawn`) + async `stageContribution` / `submitContribution` paths + async `isGit/GhAvailable` and a `ghAuthenticated` probe; the **synchronous interface is retained** for the CLI and tests. This is the deliberate, documented exception to slice 1–2's "换容器不换逻辑": the interface is widened, behaviour unchanged. The daemon serialises publishes behind a **single in-flight mutex**.
- **Stage state model** — the daemon holds a per-review `{ staged, branch }` in memory; `submit` stages first only when the flag is unset. A fresh stage that hits `branch_exists` (no staged flag) is treated as stale residue from a prior attempt: it returns guidance, it does not auto-delete the branch.
- **Step-④ 出口① three-step wizard** (replaces the slice-2 placeholder): ① 预检 (`/publish/plan` with pending + timeout states; on `precheck_refused` show rule-aggregated blocked reasons + a "回到② 查看该规则分组" jump) → ② PR 预览 (`prTitle`/`prBody` as a styled `<pre>` per the design's Open Question 3 recommendation, `stagedFiles`, branch, `compareUrl`) → ③ 提交 (`/publish/stage` always writes to disk; when `ghAvailable && ghAuthenticated`, a one-click `/publish/submit`; otherwise show the staged file locations + `plan.commands` — noting the last command is `gh pr create` — the `git push` + `compareUrl` browser fallback, and per-command copy buttons). A successful publish feeds step-④'s completion state (badge 已完成).
- **Exit-① card four states** from preflight: 就绪 / 需配置 / gh 未登录 / 缺依赖.
- **New client methods**: `getPreflight()`, `publishPlan()`, `publishStage()`, `publishSubmit()` (+ their types), additive to the existing `ApiClient`.

## Capabilities

### New Capabilities

- `publish-exit-one`: the 出口① publish path — the daemon `publish/{plan,stage,submit}` + `preflight` routes with their gate-locked-409 and typed error taxonomy, the `dataRepoPath` trusted config, the in-memory stage state model + single-flight mutex, the read-only settings display, the exit-① card's four preflight states, and the step-④ three-step publish wizard UI feeding the journey's completion state.

### Modified Capabilities

- `pr-submission`: the "gh CLI when present, documented manual path otherwise" requirement is widened to allow an **asynchronous** command-runner variant for non-blocking daemon execution, with the synchronous runner retained for the CLI and tests. Behaviour is unchanged — the same commands, the same gh-absent manual fallback.

## Impact

- **Modified packages**: `packages/daemon/` (routes + `dataRepoPath` option + CLI flag + stage-state + mutex + `compareUrl` derivation), `packages/publisher/` (async runner variant + async stage/submit + `ghAuthenticated` probe), `packages/ui/` (exit-① wizard + card states + settings data-repo row + client methods).
- **New files**: daemon `src/publish.ts` (route handlers + preflight + compareUrl + error mapping) and its tests; publisher `src/asyncRunner.ts` (or an async addition to `runner.ts`) + async stage/submit; ui `src/components/journey/PublishWizard.tsx` + tests, `src/lib/usePreflight.ts`.
- **Edited files**: daemon `app.ts` (register routes, `AppOptions.dataRepoPath`, `publishRunner` injection), `cli.ts`/`server.ts` (`--data-repo` flag → `DaemonOptions`), publisher `pr.ts` + `index.ts` (async exports), ui `api/client.ts` + `api/types.ts` (publish methods/types), `ExitCards.tsx` (wire the wizard + 4 states), `SettingsPage.tsx` (data-repo read-only row), `ReviewView.tsx` (publish → completion).
- **New dependency**: none (git/gh are external CLIs invoked via `spawn`; no npm dep).
- **Testing**: daemon publish tests inject a **fake async runner** (no real git/gh) for determinism; any test that must touch real git runs **serially with a raised timeout and skips when git is absent** — addressing the known `pr.test.ts` concurrency/timeout flakiness on Windows. Final task = root typecheck + build + vitest green + `rasen validate --strict`.
- **Out of scope** (Later): CI re-scan workflow / the community-repo side, receipt persistence + the 历史 page, HuggingFace sync, markdown rendering beyond the styled `<pre>` (Open Question 3), and any non-loopback exposure.
