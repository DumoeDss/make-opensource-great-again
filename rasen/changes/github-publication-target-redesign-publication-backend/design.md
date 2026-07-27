## Context

The approved office-hours design changes the publication product object from “a local data-repository clone” to “the canonical GitHub repository that will receive a pull request.” The current daemon still exposes the old model:

- `AppOptions.dataRepoPath` and `mosga ui --data-repo` select a caller-owned directory.
- `packages/daemon/src/publish.ts` infers the target from `origin`, exposes `ghAvailable`, commands, compare URLs, and distinct single/batch plan-stage-submit routes.
- stage state and idempotency live only in an in-memory map; successful push/failed-PR and process-restart windows are not recoverable.
- the dispatcher checks `Host`, but it does not enforce JSON content type or same-origin metadata for mutating requests and its catch-all can echo an unexpected error message.

The preceding publisher-core child is committed at `cd3d9f3e01f74ba0f94e3e427412658afc554dbd`. Its reviewed downstream boundary is:

- one synchronous, side-effect-free `compileContributionBundle` for 1–500 stamped sessions;
- `ContributionBundle.contractVersion === 1`;
- exact UTF-8 `files[].contents`, `bytes`, and SHA-256 `contentHash`;
- `contentDigest = SHA-256(JSON.stringify(path-sorted { path, bytes, contentHash } entries))`;
- deterministic records/files/branch/commit/PR metadata and static engine pins;
- record pre-check over literal `fileContents`, including the trailing newline, with rule-count-only compiler refusals.

Publisher review proved that default compilation performs no filesystem/process/network operation and that publisher identifiers reject malformed UTF-16 before encoding, preserve percent-looking input literally, emit paths under `data/`, and emit supported Git refs. Those are upstream guarantees, not authorization to write: this backend independently validates the complete bundle and applies filesystem-specific collision, containment, symlink, and junction defenses before using any path.

This child is backend-only. The following UI child will consume the typed HTTP shapes, but no `packages/ui/**` file changes here. The redesign is a development-only hard replacement: no migration, compatibility wrapper, deprecated endpoint, legacy adapter, or `--data-repo` fallback is permitted.

## Goals / Non-Goals

**Goals:**

- Provide one deep `GitHubPublication` module with `inspect`, `configure`, `clear`, `preview`, and `submit` behavior.
- Persist one canonical github.com upstream with a monotonic revision and expose only safe target/readiness state over HTTP.
- Resolve upstream and push repositories explicitly: direct when writable, otherwise the authenticated user’s verified existing fork or a fork created only after confirmed submit.
- Seal an expiring, read-only preview to exact publisher bytes, bundle contract/digest, review selection, target revision/snapshot, push route, and upstream base branch/commit.
- Revalidate gate, content, target, engine, and byte/path invariants before any submit mutation.
- Use a daemon-derived managed root and explicit, recoverable Git/GitHub operations to create one commit, one push, one PR, and one immutable receipt.
- Make retry and crash recovery converge on the same upstream/base/head pull request.
- Protect all mutating loopback routes with JSON and same-origin checks and expose stable sanitized errors only.
- Keep GitHub as a semantic true-external port while making filesystem, Git, process, clock, IDs, stores, and locks locally substitutable.

**Non-Goals:**

- No multiple active targets, target selector, GitHub Enterprise, GitLab/Gitea abstraction, arbitrary host, caller-supplied remote URL/name, branch, workspace, or credential.
- No OAuth implementation; the production adapter consumes the existing `gh` authentication store without persisting a token in application JSON.
- No GitHub Git Data API delivery adapter in the first release.
- No user-managed clone, dirty-tree guidance, manual command/compare-URL fallback, or local workspace disclosure.
- No change to publisher bundle generation, dataset record schema, sanitizer rules, review/disposition behavior, or sanitized-file-only export.
- No UI implementation and no automated real-GitHub write.

## Decisions

### D1 — `GitHubPublication` is the only target/delivery boundary

Implement the deep module under the daemon backend (for example `packages/daemon/src/publication/`) with a narrow service surface:

```ts
interface GitHubPublication {
  inspect(): Promise<PublicationStatus>;
  configure(input: { repository: string }): Promise<PublicationStatus>;
  clear(): Promise<PublicationStatus>;
  preview(input: { reviewIds: string[] }): Promise<PublicationPreview>;
  submit(input: {
    publicationRef: string;
    targetRevision: number;
    contentDigest: string;
    confirmPublic: true;
  }): Promise<PublicationReceipt>;
}
```

`packages/daemon/src/publish.ts` becomes an HTTP adapter: strict request parsing, review attribution, service calls, and domain-error mapping. It does not assemble Git/`gh` commands or infer repository semantics.

The module owns target resolution, bundle sealing, workspace orchestration, GitHub delivery, journals, and receipts. Content generation remains exclusively in `compileContributionBundle`; the backend never reconstructs record/sidecar bytes, file order, hashes, branch, or PR text through `exportSession`.

Alternative: add a new target layer around the old routes. Rejected because it would preserve two content authorities, two single/batch flows, and the forbidden local-clone/manual surface.

### D2 — Persist one canonical slug and a monotonic target revision

Accept only a strict canonical `owner/repo` string. Reject URLs (including otherwise normalizable GitHub URLs), SSH/scp forms, credentials, query/fragment text, extra path segments, dot segments, controls, whitespace, and names outside GitHub’s supported bounded grammar. The first release synthesizes all GitHub URLs internally and fixes the host to `github.com`.

Persist:

```ts
interface StoredPublicationTarget {
  schemaVersion: 1;
  revision: number;
  upstream: { owner: string; repo: string } | null;
}
```

The default location is beneath the daemon’s user-scope root (for example `~/.mosga/publication/target.json`), resolved from local `homeDir`/application options only. Tests inject a file path or in-memory store. Every semantic target change atomically writes a new revision using a unique same-directory temporary file plus rename. Reconfiguring the identical slug or clearing an already empty target is idempotent and does not bump the revision. Clear persists `upstream: null` rather than deleting revision history.

Cross-process target mutations and publication submits use a persistent lock directory with one immutable UUID claim per acquisition. A claim is completely written and synced before an atomic rename makes it visible. Dead-owner recovery deletes only that acquisition's never-reused UUID pathname; it never performs a read/check/unlink against a shared reusable lock pathname. After publishing its own claim, a contender enumerates again and withdraws on any other live claim. This removes stale-reclaim ABA while preserving fresh-process crash recovery. PID reuse or an unreadable claim fails closed rather than risking overlap.

Malformed/unreadable persisted state fails closed as a sanitized `target_store_unavailable`/blocked status. It is never silently interpreted as a different target. Configure and clear invalidate all unsubmitted in-memory previews.

Alternative: delete the file on clear and restart revisions at one. Rejected because an old preview could become revision-equal after clear/reconfigure.

### D3 — Readiness is a discriminated, HTTP-safe server result

`inspect()` reads stored state and performs semantic, read-only GitHub inspection. It returns one of:

```ts
type PublicationStatus =
  | { state: 'unconfigured'; revision: number }
  | { state: 'login_required'; revision: number; target: TargetSummary }
  | {
      state: 'fork_confirmation_required';
      revision: number;
      target: TargetSummary;
      actor: string;
      pushRepository: string;
    }
  | {
      state: 'ready';
      revision: number;
      target: TargetSummary;
      actor: string;
      route: 'direct' | 'fork';
      pushRepository: string;
      willCreateFork: false;
    }
  | {
      state: 'blocked';
      revision: number;
      target?: TargetSummary;
      issues: PublicationIssue[];
    };
```

`TargetSummary` contains only public/safe GitHub facts: stable repository ID, canonical slug/URL, public visibility, default branch, and parsed compatibility-manifest summary. `PublicationIssue` uses stable codes and curated messages/recovery text. It never contains a token, local path, raw stdout/stderr, command, remote URL with credentials, or exception text.

The resolver obtains the authenticated actor, upstream repository identity/visibility/default branch/head commit, `.mosga-dataset.json` at that exact head, viewer permission, and fork state. Direct is selected when the actor can push to upstream. Otherwise an existing repository is accepted only when its GitHub parent/source identity matches upstream. GitHub exposes no reliable read-only per-actor “can fork this public repository” bit, so if no fork exists status is `fork_confirmation_required`; preview stays read-only and reports `willCreateFork: true`, while confirmed submit performs the semantic fork attempt and maps any policy refusal to `fork_failed`.

Alternative: return capability booleans for the client to combine. Rejected because boolean combinations admit contradictory states and leak implementation concerns such as `repoClean` and CLI availability.

### D4 — Target compatibility is versioned and bound to an exact base commit

The canonical repository must be public and contain `.mosga-dataset.json` at its resolved default-branch head:

```json
{
  "kind": "mosga-community-data",
  "contractVersion": 1,
  "acceptedSchemaVersions": ["0.1.0"],
  "license": "CC-BY-4.0"
}
```

The parser is strict and bounded. `kind` and `contractVersion` must be supported, `acceptedSchemaVersions` must be a non-empty unique list containing every selected session schema, and `license` must be non-empty and not a placeholder such as `TBD`. The exact manifest bytes/hash, repository ID, default branch, base commit SHA, actor, and resolved push route form the target snapshot sealed by preview.

The manifest license is passed as an explicit trusted compiler option so the sealed PR body cannot inherit the publisher’s development `TBD` fallback. A default-branch move, manifest change, repository identity change, actor change, or route change before pre-push submit validation makes the preview stale.

Alternative: read the manifest from an unpinned branch name during submit. Rejected because readiness could change between preview and write.

### D5 — Preview is side-effect-free and seals an opaque in-memory publication

`preview({ reviewIds })`:

1. Strictly validates 1–500 non-empty IDs, rejects more than 500 input entries, deduplicates deterministically, and resolves every review with review-ID attribution.
2. Applies current dispositions and refuses any locked gate.
3. Reads the current target revision and resolves the read-only target snapshot.
4. Calls `compileContributionBundle` once with all stamped sessions, the daemon’s compiled trusted ruleset/static engine pins, deterministic options, and manifest license.
5. Validates the returned bundle contract and seals its exact values.
6. Creates a cryptographically opaque `publicationRef`, a creation time, and a bounded TTL (default 15 minutes through an injected clock).

Preview performs no filesystem write, clone/fetch/worktree operation, Git mutation, fork creation, push, PR creation, or other GitHub write. Therefore sealed previews live only in a bounded in-memory store; daemon restart intentionally requires a new preview. Clearing or changing the target invalidates them.

The private seal contains review IDs/session IDs, compiler options, complete `ContributionBundle` including `files[].contents`, target revision/snapshot, and TTL. The public response omits contents and returns:

```ts
interface PublicationPreview {
  publicationRef: string;
  expiresAt: string;
  target: {
    repositoryId: string;
    revision: number;
    upstream: string;
    pushRepository: string;
    route: 'direct' | 'fork';
    forkProvision: 'none' | 'existing' | 'on-submit';
    baseBranch: string;
    baseCommitSha: string;
    willCreateFork: boolean;
  };
  contribution: {
    contractVersion: 1;
    contentDigest: string;
    branch: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    recordCount: number;
    totalBytes: number;
    files: Array<{
      kind: 'record' | 'provenance';
      path: string;
      bytes: number;
      contentHash: string;
    }>;
    engine: EngineInfo;
  };
}
```

Alternative: persist previews for restart survival. Rejected because the fixed contract forbids preview filesystem writes; persistence begins only after confirmed submit.

### D6 — Treat the publisher bundle as untrusted until all invariants pass

At preview and again before submit mutation, validate:

- known `contractVersion`, record count/array lengths, unique session IDs, record/file associations, canonical ordering, and no duplicate paths;
- every path is normalized POSIX-relative beneath `data/`, contains no controls/backslashes/dot segments, and maps to a portable safe filesystem component;
- no platform-canonical collision (including case-insensitive collisions on Windows), reserved device component, or duplicate resolved destination;
- every `bytes` equals UTF-8 byte length, every `contentHash` equals SHA-256 of exact `contents`, `totalBytes` equals the sum, and recomputed contract-v1 `contentDigest` equals the bundle value;
- branch/ref grammar, lowercase hexadecimal digest/hash lengths, and non-empty static engine pins;
- every path named by a record exists exactly once with the expected kind/session, and the selected session schema versions are accepted by the manifest.

The implementation may reuse the exported `computeContributionContentDigest`, but validation remains backend-owned and fails closed on any mismatch. Publisher’s reviewed malformed-UTF-16 and percent-encoding defenses are carried forward; the extra platform collision checks address filesystem semantics that a repo-relative content compiler cannot authorize.

Alternative: trust TypeScript types and publisher call locality. Rejected because the exact paths/bytes cross a module and later refactors, mocks, persistence, or malformed values must not turn a type assertion into filesystem authority.

### D7 — Submit revalidates mutable state before its first write

The submit body is strict and accepts only:

```json
{
  "publicationRef": "publication_opaque",
  "targetRevision": 7,
  "contentDigest": "lowercase-sha256",
  "confirmPublic": true
}
```

Extra fields—including workspace, URL, remote, base/head, fork, branch, token, and command fields—are rejected. Under the publication single-flight lock, submit:

1. Returns an existing immutable receipt for the same ref/digest/revision.
2. Loads the unexpired seal and compares request revision/digest exactly.
3. Re-reads the target store and compares revision.
4. Re-obtains every review, reapplies dispositions, and confirms every gate remains unlocked.
5. Recompiles with the same sealed trusted options; compares contract version, content digest, and exact file commitments to the seal.
6. Re-resolves GitHub read-only state and compares the sealed target snapshot.
7. Revalidates the complete sealed bundle.
8. Runs the final mandatory structured plus raw-byte pre-check on each exact record body (including trailing newline) and the raw-byte backstop on every exact provenance sidecar. Refusal is grouped by review/session/rule count only.

Only after all steps pass may submit atomically create the `validated` journal and begin workspace/Git/GitHub writes. That strict, versioned journal contains the exact seal that passed these gates and becomes the durable recovery authority. Any retry that finds it follows D10 recovery instead of consulting the volatile preview/review stores or re-resolving the current target; otherwise a daemon restart could strand a confirmed publication before push or silently retarget it.

Alternative: write the workspace first and pre-check immediately before push. Rejected because the contract requires preview purity and submit’s last safety gate to precede every local or remote mutation.

### D8 — Managed workspaces are derived locally and write exact sealed bytes

The daemon derives a private root such as:

```text
~/.mosga/publication/
  target.json
  previews/       # absent in v1; previews are memory-only
  receipts/
  journals/
  cache/<repository-id-hash>.git/
  worktrees/<publication-ref>/
  runtime/
```

`AppOptions.publicationRoot` is an internal/test injection only and has no CLI or HTTP surface. Cache names derive from a SHA-256 of the stable GitHub repository ID, never a user slug. Each publication uses an owned marker and a dedicated worktree based on the sealed upstream base commit.

Before each write, resolve the candidate parent and destination without following an attacker-created leaf, prove containment beneath the owned worktree, reject any symlink/reparse-point/junction component, create parents one component at a time, open files with non-follow/exclusive-safe semantics where supported, write UTF-8 exact `contents`, and then re-read to verify byte length and SHA-256. Cleanup/removal is permitted only for a marker-owned path whose final resolved location is beneath the managed root.

Git commands use argument arrays with `shell: false`, fixed internal remote names `upstream` and `push`, and explicit path separation:

```text
git add -- <exact validated paths...>
git push push HEAD:refs/heads/<sealed-branch>
```

The branch is created from the sealed base commit. The backend appends a full content-digest trailer to the sealed publisher commit message and records the resulting commit/tree SHAs. A remote branch is reusable only when its fetched tree SHA equals the expected tree SHA; otherwise submit returns `branch_conflict`.

Git authentication is an opaque production-adapter concern. An ephemeral private askpass/credential handle may obtain the current `gh` credential in memory for a child process, but a token is never placed in a remote URL, command argument, journal, receipt, config file, log, or HTTP result.

Alternative: clone into a user-selected path and sanitize it. Rejected because accepting the path is the primary capability vulnerability this redesign removes.

### D9 — GitHub is semantic; upstream and push are never inferred

Define a true-external port around domain operations, not raw command strings:

```ts
interface GitHubPort {
  inspectActor(): Promise<GitHubActor>;
  inspectRepository(slug: string): Promise<GitHubRepositorySnapshot>;
  readDatasetManifest(input: {
    repository: string;
    commitSha: string;
  }): Promise<DatasetManifestSource>;
  inspectFork(input: {
    upstreamRepositoryId: string;
    actor: string;
    expectedSlug: string;
  }): Promise<GitHubFork | null>;
  ensureFork(input: ForkRequest): Promise<GitHubFork>;
  findPullRequest(input: PullRequestIdentity): Promise<GitHubPullRequest | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
}
```

The production `gh` adapter uses explicit repository arguments for every call and parses bounded structured JSON. Fork creation is reachable only from confirmed submit, then waits with bounded backoff until the created/existing fork reports the correct upstream source identity.

PR lookup uses `gh api` against the sealed upstream and verifies every returned candidate’s upstream repository node ID/full name, base ref, head repository full name, head ref, PR number, and URL before adoption. Ambiguous exact matches fail closed. PR creation always carries explicit upstream/base and a route-correct head:

```text
direct: --repo <upstream> --base <base> --head <sealed-branch>
fork:   --repo <upstream> --base <base> --head <actor>:<sealed-branch>
```

The bare direct head is required because `gh pr create` rejects an organization name in `<user>:<branch>`, while fork lookup cannot rely on `gh pr list --head <owner>:<branch>`. No operation consults the process cwd or `origin`. The fake adapter models login, direct permission, existing/on-submit fork, fork propagation, target movement, network failure, existing PR, and PR conflict. Automated tests never invoke a real GitHub write.

Alternative: expose a generic `runGh(args)` port to the service. Rejected because callers could reintroduce implicit cwd/repository semantics and tests would assert command syntax instead of the upstream/push domain contract.

### D10 — Journal irreversible phases and converge retries on one PR

Confirmed submit atomically creates a versioned journal containing the sealed publication, internal workspace identity, and state machine:

```text
validated
  -> committed(commitSha, treeSha)
  -> fork_ready(pushRepository)
  -> pushed(commitSha, treeSha)
  -> pr_observed(prNumber, prUrl)
  -> completed(receipt)
```

Each transition is atomic and monotonic. The immutable receipt is written atomically before the journal is marked completed. Receipt lookup is first on every retry.

Recovery rules:

- The first confirmed attempt performs every current review/gate/content/target check before writing `validated`. Once that journal exists, recovery at `validated`, `committed`, or `fork_ready` validates the journal’s exact phase schema, seal, request bindings, bundle hashes, and target/base/push bindings, then resumes from that durable authority without requiring the in-memory preview or `ReviewStore`.
- A later target configuration change never retargets a journaled confirmed publication, even before push. It affects only future previews/submits. The already confirmed operation keeps its sealed upstream/base/head.
- If the remote branch exists, fetch it and compare its complete tree SHA with the journal’s expected tree. Equal means `pushed`; unequal means `branch_conflict`, never overwrite/force-push.
- After push, retry first calls `findPullRequest` with the exact upstream/base/head identity. An existing PR is adopted.
- If PR creation succeeded but the response/journal write was lost, lookup adopts that PR instead of creating a duplicate.
- If no PR exists, create exactly one, immediately persist `pr_observed`, then persist the receipt.
- A target configuration change after a proven push does not retarget recovery; recovery uses the journal’s sealed upstream/base/head and reports the resulting receipt. It never switches to the newly configured target.

The public receipt is:

```ts
interface PublicationReceipt {
  publicationRef: string;
  targetRevision: number;
  upstream: string;
  pushRepository: string;
  mode: 'direct' | 'fork';
  baseBranch: string;
  baseCommitSha: string;
  branch: string;
  commitSha: string;
  prNumber: number;
  prUrl: string;
  recordCount: number;
  contentDigest: string;
  submittedAt: string;
}
```

It contains no file contents, local path, credential, command, or raw process output.

Alternative: rely on branch naming alone. Rejected because the eight-character branch suffix can collide and cannot close the push-success/PR-response-loss window.

### D11 — Harden every mutating no-auth loopback route

The dispatcher retains loopback binding and strict loopback `Host`. Before reading a mutating body (`POST`, `PUT`, `PATCH`, `DELETE`) it additionally:

- requires an `application/json` media type (optional charset is accepted), otherwise returns 415;
- rejects `Sec-Fetch-Site: cross-site`;
- when `Origin` is present, requires exact equality with the daemon origin derived from the validated loopback Host; `Origin: null`, alternate port, scheme, or hostname is rejected;
- sends no CORS allow headers.

Missing `Origin` remains valid for trusted non-browser local clients, but it receives no exemption from Host or JSON checks. The rule applies to existing review/provider/direct-submit mutations as well as publication routes.

The top-level catch never serializes `err.message`. Publication exceptions are normalized to:

```ts
interface PublicationErrorBody {
  code: PublicationErrorCode;
  phase: 'target' | 'preview' | 'workspace' | 'push' | 'pull_request';
  message: string;
  retryable: boolean;
  recovery?: string;
}
```

Codes are stable and include `invalid_target`, `target_not_configured`, `target_not_found`, `target_incompatible`, `target_changed`, `target_store_unavailable`, `github_client_missing`, `github_login_required`, `github_unavailable`, `permission_denied`, `fork_confirmation_required`, `fork_failed`, `review_not_found`, `GATE_LOCKED`, `precheck_refused`, `preview_not_found`, `preview_expired`, `preview_stale`, `publish_in_flight`, `workspace_unavailable`, `workspace_corrupt`, `branch_conflict`, `push_rejected`, and `pr_create_failed`.

External stderr/stdout, exception text, commands, tokens, and local paths are discarded or retained only behind non-HTTP private diagnostics after semantic mapping; public messages are curated constants.

Alternative: add CORS for the UI origin. Rejected because UI and API are same-origin and CORS would broaden the no-auth attack surface.

### D12 — Backend-owned CLI/docs have no legacy escape hatch

Delete `--data-repo` parsing, help, startup propagation, `AppOptions.dataRepoPath`, `validateDataRepoPath`, publisher-runner imports, and all old publish routes/tests. An unknown `--data-repo` is not silently ignored; normal CLI unknown-option validation must reject it.

Document the new target as HTTP/UI-managed canonical GitHub configuration, the managed-root/no-path boundary, github.com/`gh auth` prerequisite, preview/submit semantics, and safe status/error model. Add `.mosga-dataset.json` plus a validator/test to `templates/community-data-repo`, and remove template/root guidance that tells users to stage locally or run manual commands.

The development template must also install as a repository in its own right.
The internal `@mosga` packages are not yet published to npm, so the template
vendors exact `0.1.0` tarball snapshots of contracts, session-readers,
sanitizer, and publisher, and pins their integrity in its own
`package-lock.json`. Those four tarballs and the lockfile are one coordinated
engine release: they move together, and the workflow watches `vendor/**`.
This is a development release mechanism rather than a migration; once the
packages are published, the entire unit may be replaced with exact registry
pins in one reviewed change.
The template's own compatibility check decompresses every vendored archive and
rejects every bounded drive-rooted `X:\Users\` occurrence, every NUL-bearing
entry, and known private workspace-root strings. Static documentation examples
use `%USERPROFILE%` rather than a concrete profile component. A coordinated
tarball update must match a fresh pack of the current built package and refresh
the lockfile integrity before the clean-copy `npm ci`/check gate.

Alternative: retain the flag but ignore it. Rejected because it implies compatibility and can hide operator misconfiguration.

## Risks / Trade-offs

- **[Preview is lost on daemon restart]** → Preview cannot write the filesystem by contract, so return `preview_not_found` and require a new preview; once confirmed submit starts, the durable journal takes over.
- **[GitHub state changes after preview]** → Bind repository ID, actor, route, manifest, base branch, and base commit; fail pre-push submit as `preview_stale`.
- **[Crash between push, PR creation, and receipt]** → Persist monotonic journal phases and adopt the exact upstream/base/head PR before any create call.
- **[Branch suffix collision or hostile pre-existing branch]** → Compare the fetched full Git tree SHA; never force-push a mismatching branch.
- **[Publisher-safe paths collide on a platform filesystem]** → Add portable component checks, case-canonical collision detection, resolved containment, and symlink/reparse-point rejection at the backend boundary.
- **[A malicious webpage drives the no-auth API]** → Combine loopback bind, Host allowlist, same-origin fetch metadata/Origin checks, JSON-only mutation, and zero CORS.
- **[`gh` output or Git errors leak secrets/paths]** → Parse structured bounded outputs behind semantic adapters and return only stable curated errors; tokens never enter arguments, persistence, or HTTP.
- **[Fork creation is an irreversible surprise]** → Preview clearly reports `willCreateFork`, and `ensureFork` is reachable only after `confirmPublic: true`.
- **[Two daemon processes share one managed root]** → Use acquisition-specific UUID claim files for target mutations and publication single-flight. Dead claims are recovered only by their never-reused pathname; live or unreadable claims fail closed, so a stale reclaimer cannot ABA-delete a replacement holder.
- **[Large 500-record seals consume memory]** → Keep the existing hard bound, one canonical bundle, bounded preview store/TTL, and release seals on expiry/configuration change/completion.

## Migration Plan

This is a hard development-time replacement, not a data migration.

1. Add target/status contracts, strict slug/manifest parsing, atomic file/in-memory stores, the semantic GitHub port/fake/production adapter, and safe error mapping.
2. Add sealed preview and complete bundle-boundary validation using the committed publisher compiler.
3. Add managed workspace/Git/process seams, exact-byte writer, journals, receipts, fork/direct delivery, and recovery tests.
4. Replace daemon route wiring and tests; remove old single/batch routes, `dataRepoPath`, publisher delivery imports, and `--data-repo`.
5. Add the compatibility manifest/template validation and update backend-owned documentation.
6. Run daemon/publisher contract tests, local Git workspace integration tests, repository typecheck/build/test, strict Rasen validation, and scans proving no UI edit or real GitHub write.

There is no legacy state import. Any old CLI invocation or endpoint fails because the surface no longer exists. Before portfolio delivery, rollback is a commit revert of this child plus the preceding publisher child if necessary; no production migration or external repository operation is performed by the implementation/test process.

## Open Questions

None within this child. The official production `owner/repo`, final dataset license, and final accepted schema list remain pre-launch product decisions, but the backend and template require concrete non-placeholder manifest values before reporting a target ready.
