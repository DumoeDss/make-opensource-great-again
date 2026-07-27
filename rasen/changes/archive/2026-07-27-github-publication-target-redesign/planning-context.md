# Planning context — GitHub publication target redesign

## User intent

The user requested:

> `$rasen-auto auto-decompose` 新建 worktree，创建新的开发分支开始开发。完成后提交 PR。

Runtime override:

> 不要使用 Claude / Claude Code，直接使用 Codex。

The approved product decision is recorded in:

`rasen/office-hours/github-publication-target-redesign.md`

The implementation is a hard replacement because the project is still under
development. There is no migration, compatibility layer, deprecation period,
legacy route, or `LegacyCloneWorkspaceAdapter`.

## Working copy

- Worktree:
  `E:/AI/ChatAI/Agents/VibeCodingProjects/make-deepseek-great-again-github-publication`
- Branch: `feat/github-publication-target`
- Base: `main` at `a4c0bd23dd7c502e446b0bf2be6b4250cff287fb`
- Worker runtime for every role: `codex`
- Parent pipeline: `auto-decompose`
- Child pipeline: `small-feature`
- Gate policy: `off` from global configuration

## Codex-native orchestration state

- Current execution view: Codex host, Tier `A`, worker runtime `codex`,
  dispatch mode `native`.
- New leaf workers are dispatched with `spawn_agent`. An idle worker receives a
  new turn through `followup_task`; `send_message` is only for guidance while a
  worker is running.
- A Codex worker's final response is delivered to the LEAD automatically. No
  duplicate completion message is sent.
- `wait_agent` is reserved for a single event-driven wait at a real dependency
  barrier; polling loops are not part of this run's protocol.
- Native agent handles are scoped to the host session and expired when the
  session restarted. No old handle is revived and no thread or transcript
  identity is synthesized.
- No Direction workstream/Slice layer exists for this run. The active unit is
  the decomposed portfolio below; its UI child is active at the review-loop
  frontier.
- Resume recovery for the current frontier is explicitly degraded to cold
  reconstruction from this planning context, validated run-state, child
  artifacts, and durable work reports because no current-stage handoff or
  surfaced transcript exists.

The original main worktree contains unrelated local changes. Do not copy,
modify, commit, clean, or reset them. All product work belongs in this dedicated
worktree.

## Decomposition

The leading decompose stage is taken. The scope crosses three distinct
capabilities with strict dependencies:

1. `github-publication-target-redesign-publisher-core`
   - Make publisher planning pure.
   - Remove `targetRepo`, `ghAvailable`, manual commands, and Git/GitHub delivery
     concerns from the public contribution plan.
   - Unify single and batch contribution-bundle generation while preserving
     exact-byte precheck and deterministic output contracts.

2. `github-publication-target-redesign-publication-backend`
   - Depends on publisher-core.
   - Implement the single active GitHub target, target persistence, semantic
     GitHub port, direct/fork resolution, sealed preview, managed workspace,
     idempotent submit/receipt, and new daemon HTTP routes.
   - Delete `--data-repo`, `dataRepoPath`, local-clone preflight, old
     single/batch plan-stage-submit routes, and path/command HTTP exposure.
   - Add `.mosga-dataset.json` target compatibility contract and template checks.

3. `github-publication-target-redesign-publication-ui`
   - Depends on publication-backend.
   - Replace the read-only data-repo settings row with editable GitHub target
     configuration and typed publication status.
   - Unify single/batch publishing through `reviewIds` and one wizard.
   - Use preview → submit, show upstream/push/fork explicitly, return a real PR
     receipt, and retain sanitized-file-only export as the fallback.

Dependency DAG:

```text
publisher-core
      ↓
publication-backend
      ↓
publication-ui
```

All children run serially. They overlap on contracts and generated types, so
there is no positive independence proof for parallel execution.

## Fixed constraints

- The UI configures only normalized GitHub `owner/repo`, never a local path,
  remote URL, remote name, push URL, branch, fork repository, or token.
- The daemon owns the workspace under a trusted internal root and never returns
  its absolute path over HTTP.
- `upstream` is the canonical PR target; `push` is upstream or the authenticated
  user's fork. PR creation must pass upstream/base/head explicitly.
- Preview has no GitHub write side effects.
- Submit is bound to target revision and exact-byte content digest.
- Human gate and mandatory final-byte precheck remain non-bypassable.
- Precheck refusal returns rule-aggregated counts only.
- Single and batch use the same publication interface; N=1 is not a separate
  implementation.
- No real external repository is modified by automated tests.
- Author and verifier must be different Codex workers.

## Portfolio delivery

Each child ships locally (commit only). After every child is implemented,
verified, and review-clean, the parent performs one delivery: push the branch and
open one PR. Never push a partial portfolio.

## Durable publisher-core findings

- The downstream boundary is a versioned `ContributionBundle` containing the
  exact UTF-8 record/provenance file contents plus per-file byte counts and
  SHA-256 hashes. Its v1 `contentDigest` commits to the path-sorted canonical
  `{ path, bytes, contentHash }` manifest. The backend must seal and write these
  supplied bytes; it must not independently reconstruct publisher output.
- The mandatory precheck must receive each record's literal `fileContents`
  (including the trailing newline), not the newline-free `jsonl` helper. Bundle
  refusal aggregates deterministic per-session rule counts and exposes no match
  previews or raw values across the module boundary.
- Raw session-ID uniqueness is insufficient because distinct IDs can collide
  after path slugification. The compiler must also reject duplicate derived
  record/provenance paths, and canonical ordinal session ordering plus
  path-sorted files makes the entire bundle independent of request order.

## Durable publication-backend planning findings

- Target persistence keeps `{ schemaVersion: 1, revision, upstream|null }`;
  clear advances and preserves the monotonic revision instead of deleting it,
  so an old preview can never become current again after clear/reconfigure.
- Preview is bounded, opaque, expiring, and memory-only because it may not write
  the filesystem. It seals exact Publisher bytes plus the target repository ID,
  manifest identity/license, actor/route, default branch, and base commit.
  Durable journal/receipt persistence begins only after confirmed submit passes
  every pre-write gate.
- Publisher path/ref guarantees are necessary but not filesystem authority. The
  backend revalidates contract/digest/bytes/hashes/associations and additionally
  rejects portable-device names, platform case-fold collisions, containment
  escapes, and symlink/reparse-point/junction traversal before exact-byte writes.
- Submit accepts only publication ref, target revision, content digest, and
  literal public confirmation. It recompiles current gated reviews with the
  sealed engine/options, repeats exact record prechecks plus a raw-byte backstop
  over provenance sidecars, and exposes refusals only as review/session/rule
  counts.
- Recovery journals full commit/tree identity and explicit upstream/base/head.
  A same-named remote branch is reusable only when its complete tree matches;
  retry adopts an existing exact PR before creating one, closing push/PR/receipt
  crash windows without force-push or retargeting.
- GitHub is the only true-external semantic port. Production `gh` calls and Git
  pushes use explicit repositories/remotes with opaque ephemeral credentials;
  automated tests use a fake GitHub adapter and local temporary Git repositories
  only. All mutating loopback routes also receive JSON/same-origin guards and
  stable sanitized errors.
