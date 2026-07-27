## Context

The approved office-hours design replaces “a user-owned local data-repository clone” with “the canonical GitHub repository that will receive the pull request.” The publisher and publication-backend children are already committed and independently review-clean. The UI is now the only live product surface that still exposes the removed model:

- `PublishPreflight` combines five booleans (`dataRepoConfigured`, Git/`gh` availability, authentication, and worktree cleanliness) into client-invented states.
- Settings presents the target as a read-only startup path and instructs the user to restart with `--data-repo`.
- single and batch use separate plan/stage/submit clients and separate wizard components.
- the submit step can expose staged paths, generated commands, and compare URLs as a manual fallback.
- completion records only a synthetic branch/title summary rather than the real pull-request receipt.

The committed backend instead exposes one same-origin contract:

```text
GET    /api/publish
PUT    /api/publish/target   { repository: "owner/repo" }
DELETE /api/publish/target
POST   /api/publish/preview  { reviewIds: string[] }
POST   /api/publish/submit   {
  publicationRef,
  targetRevision,
  contentDigest,
  confirmPublic: true
}
```

All mutations require JSON and the daemon’s same-origin guard. `PublicationStatus` is the server-owned readiness state. A preview is opaque, memory-only, and normally expires after 15 minutes; it contains only safe summaries while the daemon privately seals exact bytes. Submit is idempotently bound to the preview ref, target revision, and content digest.

The backend’s CLEAN review leaves several durable UI constraints:

- Treat the discriminated status and stable error code as authoritative; never reconstruct readiness from client booleans.
- `blocked.target` is optional. When safe target facts are unavailable, the UI must not invent, cache as authority, or render a guessed repository.
- `fork_confirmation_required` is publishable through a read-only preview, but it requires an explicit later confirmation because submit may create a public fork.
- `ready.willCreateFork` is always false; preview is where `forkProvision` and `willCreateFork` are sealed and shown.
- Preview loss on daemon restart is expected. The UI must discard its preview and create another rather than persist or replay it locally.
- Retryable submit failures must retry the exact same ref/revision/digest so backend recovery can adopt the same branch/PR.
- Public payloads contain repository-relative file paths and public Git facts but no workspace, token, commands, raw output, or exact file contents. The UI must not add a second disclosure channel.

The existing React 18/Vite/Tailwind application already has a warm-ivory token system, reusable Button/Input/Badge/Dialog/AdvancedFold primitives, a responsive dual-card exit layout, a one-time donation affirmation, and component-level Vitest/jsdom tests. This change reuses those patterns; it is not a visual-system redesign.

## Goals / Non-Goals

**Goals:**

- Mirror the backend’s public publication types exactly in `packages/ui`.
- Give Settings one clear `owner/repo` edit/save/refresh/clear workflow with complete safe readiness facts.
- Make one `usePublication` hook the status-loading boundary instead of deriving status in components.
- Make one `PublishWizard` handle both N=1 and N>1 `reviewIds`.
- Show the canonical upstream, actual push repository, direct/fork route, base, fork-creation effect, PR metadata, exact safe file commitments, expiry, and content digest before submit.
- Require a dedicated public-publication confirmation and send only the four strict submit fields.
- Recover coherently from expired/lost/stale previews and retry transient delivery without creating a second client-side publication identity.
- Render the real PR receipt and preserve exit ②, batch direct-submit, the donation affirmation, and sanitized-file export unchanged.
- Preserve accessibility, responsive behavior, and the current component/style vocabulary.

**Non-Goals:**

- No daemon, publisher, template, CLI, or backend-test edits.
- No local path, remote URL/name, push URL, branch override, fork selector, host selector, token, or workspace configuration.
- No multiple-target list, GitHub Enterprise, OAuth flow, or automatic `gh auth` launcher.
- No client persistence of target status, preview, receipt, or exact contribution content.
- No manual stage/command/compare fallback and no compatibility call to a removed route.
- No change to direct-submit provider/key/consent behavior.
- No new visual system, navigation structure, animation framework, or heavy browser-test framework.
- No automated real-GitHub write.

## Decisions

### D1 — Mirror the committed public contract and centralize publication transport

Replace the old publication section of `api/types.ts` with exact client-side mirrors of:

- `TargetSummary`, manifest summary, `PublicationIssue`, and the five-state `PublicationStatus`;
- `PublicationFileSummary`, `PublicationPreview`, and `PublicationReceipt`;
- `PublicationErrorBody`, including optional `reviewId`, safe gate projection, and rule-count-only `refusals`.

Replace `getPreflight`, per-review plan/stage/submit, and batch plan/stage/submit with:

```ts
inspectPublication(): Promise<PublicationResult<PublicationStatus>>;
configurePublicationTarget(repository: string):
  Promise<PublicationResult<PublicationStatus>>;
clearPublicationTarget(): Promise<PublicationResult<PublicationStatus>>;
previewPublication(reviewIds: string[]):
  Promise<PublicationResult<PublicationPreview>>;
submitPublication(input: {
  publicationRef: string;
  targetRevision: number;
  contentDigest: string;
  confirmPublic: true;
}): Promise<PublicationResult<PublicationReceipt>>;
```

`PublicationResult<T>` is a discriminated success/error union. One helper parses failed responses into the stable safe error shape and falls back to a generic client transport error when the response is malformed. Publication components never reach into an exception string or an `error` property from the legacy protocol. Existing non-publication client behavior is not refactored.

Every URL remains relative and same-origin. PUT/DELETE/POST explicitly send `Content-Type: application/json`; DELETE sends no JSON body because the backend schema requires `body === undefined`.

Alternative: import daemon source types into the UI. Rejected because daemon is not a browser package and this would pull a server implementation boundary into the Vite graph. Contract-mirroring plus focused shape fixtures keeps the dependency direction explicit.

### D2 — Replace `usePreflight` with a small server-state hook

Delete `usePreflight.ts` and add `usePublication.ts`. The hook owns:

- `status: PublicationStatus | null`;
- a separate UI load state (`loading | loaded | error`) rather than inventing a sixth domain status;
- the last safe `PublicationErrorBody | null`;
- `refresh()`;
- configure and clear actions with pending-operation state.

It calls only the new typed client methods and replaces status atomically with the returned server value. It does not cache in local storage, derive readiness booleans, or preserve a previously resolved target when the new response omits it.

Both Settings and the exit cards may instantiate the hook. They are separate destinations and do not require a new global store; each refreshes on mount and after its own mutation. This keeps publication state server-owned and avoids coupling the existing `AppShell` to review journey internals.

Alternative: introduce a React context and client cache. Rejected because there is only one lightweight GET and no live cross-destination view that requires synchronized optimistic state.

### D3 — Settings edits one canonical target and renders only safe facts

Replace the `settings-data-repo` section with “GitHub publication target.” It contains:

- a labeled `owner/repo` text input with an example and format guidance;
- Save/validate, Refresh status, and Clear target actions;
- a status badge driven by the exact server state;
- an accessible definition list for the safe fields that exist: canonical target slug, actor, default branch/base commit, direct/fork route, push repository, target revision, compatibility contract/schemas/license, and readiness issues;
- a clear confirmation explaining that local configuration and unsubmitted previews are cleared, while existing remote forks/branches/PRs are not deleted.

The UI may perform lightweight non-empty and `owner/repo`-shape checks for immediate feedback, but the server remains authoritative. It submits only `{ repository }`; it never accepts URLs, paths, hosts, credentials, remotes, branches, or tokens.

Status rendering is exhaustive:

| State | Settings meaning | Publish entry |
|---|---|---|
| `unconfigured` | no active target; edit form is primary | disabled |
| `login_required` | compatible target known; show target and `gh auth login` recovery | disabled |
| `fork_confirmation_required` | actor/upstream/predicted push known; public fork may be created after confirmation | enabled |
| `ready` | show actor, direct/existing-fork route and push repository | enabled |
| `blocked` | show only provided target facts and curated issue/recovery text | disabled |

When `blocked.target` is absent, render “target details unavailable” and keep the input available for re-entry or clear. Do not treat the last draft as the configured target after a refresh. The public `TargetSummary.url` is not rendered because the requested UI surface uses canonical slugs and the PR receipt URL; no remote URL belongs in Settings.

Long slugs, hashes, and issue text wrap within the card. Labels are associated, mutation errors use `role="alert"`, async state uses `aria-live`, and controls retain visible focus through existing primitives.

Alternative: save the last target slug in browser storage to fill the blocked case. Rejected because it creates a stale second source of truth and can misrepresent the daemon’s active revision.

### D4 — One status-driven public-contribution card for single and batch

`ExitCards` and `BatchExitCards` keep their established dual-card layouts and all exit ②/export behavior. Their exit ① portions consume `usePublication` and pass `reviewIds` into the same `PublishWizard`:

```tsx
<PublishWizard
  client={client}
  reviewIds={[reviewId]} // or all queue IDs
  onPublished={...}
  onJumpToReviewIssue={...}
/>
```

The card shows a concise target route summary:

- direct: “Contribute to `<upstream>`; push to the same repository”;
- existing fork: “Open a PR to `<upstream>` through `<pushRepository>`”;
- fork confirmation: “A public fork `<pushRepository>` may be created after confirmation.”

Only `ready` and `fork_confirmation_required` enable the publication action. Login, unconfigured, blocked, loading, and transport failure states provide safe guidance and a Settings/refresh affordance without a manual publication path. N=1 and N>1 differ only in copy/count; they no longer select different HTTP methods or components.

Alternative: retain `BatchPublishWizard` as a thin wrapper. Rejected because the required hard replacement calls for one implementation and the wrapper preserves unnecessary divergent tests and state.

### D5 — The shared wizard is an explicit preview → public confirmation → submit state machine

The UI retains the familiar three-part visual story while mapping it to the two backend writes:

1. **Safety preview** — call `previewPublication({ reviewIds })`; show progress and safe attributed refusals.
2. **PR preview** — show the sealed target and contribution summaries.
3. **Confirm and create PR** — open a dedicated confirmation dialog, then submit the exact sealed binding.

Use an explicit reducer/state machine rather than loosely coupled booleans:

```text
previewing
  -> preview_ready
  -> confirming
  -> submitting
  -> succeeded
  -> retryable_error
  -> previewing (new preview required)
```

The preview view shows:

- expiry time and a live “preview expired” guard;
- upstream, push repository, `direct | fork`, existing/on-submit fork, and base branch/commit;
- branch, PR title/body, record count, total bytes, and content digest;
- every repository-relative file path, kind, bytes, and content hash;
- engine pins in an Advanced fold.

No file `contents`, workspace, path outside the repository, remote URL, command, raw output, token, or arbitrary raw response JSON is rendered. Tables use a horizontal overflow container on narrow screens, while target facts collapse from two columns to one.

The existing queue-wide donation affirmation remains the gate before opening exit ①. It is distinct from the final publication confirmation: the first confirms the sanitized donation decision; the second confirms an externally visible GitHub PR and, when `willCreateFork`, the creation of a public fork. The final dialog repeats upstream, push repository, record count, and fork effect. Only its confirm handler creates:

```ts
{
  publicationRef: preview.publicationRef,
  targetRevision: preview.target.revision,
  contentDigest: preview.contribution.contentDigest,
  confirmPublic: true,
}
```

No value is user-editable or reconstructed. Closing/cancelling the dialog sends nothing.

Alternative: use one confirmation for both donation and publication. Rejected because the two confirmations cover different decisions and the fork/target details do not exist until preview.

### D6 — Freshness codes replace the preview; retryable delivery errors preserve it

The client groups stable error codes by required UI transition:

- `preview_not_found`, `preview_expired`, `preview_stale`, and `target_changed`: discard preview and receipt state, refresh publication status, return to the safety-preview step, and require a new read-only preview for the same `reviewIds` before confirmation can reappear.
- `review_not_found` and `GATE_LOCKED`: discard preview, call `onJumpToReviewIssue(reviewId)` when attribution exists, and return the journey to disposition review.
- `precheck_refused`: show only `reviewId`, `sessionId`, and `blockingByRule` counts; offer per-review/per-rule jump actions and never render raw matches.
- retryable delivery codes such as `publish_in_flight`, `github_unavailable`, `fork_failed`, `workspace_unavailable`, `push_rejected`, and `pr_create_failed`: retain the exact preview binding and offer retry of the exact same submit body so backend journal/receipt recovery remains idempotent.
- non-retryable target/workspace/branch errors: show curated message/recovery, refresh status when target-related, and require a new preview if the sealed assumptions cannot be reused.

The UI uses the server’s `message`, `recovery`, and `retryable` fields only after the publication client has projected a valid safe error shape. It does not map raw status text or display unknown response objects. A failed network response produces generic local copy.

The client-side expiry timer is UX only. The daemon remains the authority at the boundary; a race after the timer is handled by the same freshness-code transition.

Alternative: automatically resubmit after generating a replacement preview. Rejected because a new target/content snapshot requires the user to inspect and confirm it again.

### D7 — The real receipt is the publication completion state

On success, the wizard retains and renders the exact `PublicationReceipt`:

- clickable `prUrl` plus PR number;
- canonical upstream and actual push repository;
- direct/fork mode, base branch/commit, contribution branch/commit;
- record count, target revision, content digest, and submitted time.

The PR link opens safely in a new tab with `rel="noreferrer"`. Hashes and slugs use wrapping monospaced presentation. The successful receipt triggers the existing `onPublished` callback so the journey badge becomes completed, but the receipt remains visible in the wizard rather than reducing the result to a boolean.

Submitting again from a retry state reuses the same binding; a successful idempotent backend retry simply renders the returned receipt. The UI never fabricates a compare URL or assumes a PR number from the branch.

Alternative: store only `prUrl` in `ReviewView`. Rejected because it discards the audit fields the backend deliberately returns and makes retry/completion harder to verify.

### D8 — Hard-delete the legacy surface and preserve unrelated behavior

Delete:

- `PublishPreflight`, `PublishPlan`, `PublishStageResult`, `PublishSubmitResult`, all batch counterparts, and the old `PublishError`;
- `getPreflight`, `publishPlan`, `publishStage`, `publishSubmit`, and all `publishBatch*` methods;
- `usePreflight.ts`;
- `BatchPublishWizard.tsx`;
- manual fallback renderers, stage buttons/state, command-copy UI, compare links, Git/`gh` readiness copy, dirty-worktree guidance, and `--data-repo` settings copy;
- obsolete tests/fixtures that assert old states or routes.

Update in place rather than wrapping. `BatchSubmitPanel`, `SubmitPanel`, provider/key settings, theme, daemon health, affirmation/void guards, disposition jumps, and export implementations remain behaviorally unchanged.

Alternative: keep aliases until a later cleanup. Rejected because the project is in development and the parent design explicitly forbids migration or compatibility.

### D9 — Test at the contract, component, and runnable-browser boundaries

Focused tests cover:

- exact methods, relative URLs, JSON headers/bodies, DELETE-without-body, safe error projection, and rejection of legacy client methods/types;
- every status branch in the hook, Settings save/clear/refresh, optional blocked target, and no forbidden value in rendered output;
- one shared wizard with one and multiple review IDs;
- direct, existing-fork, and on-submit-fork preview copy;
- public confirmation cancel/confirm and the exact four-field submit body;
- expiry/restart/stale/target-change re-preview transitions;
- attributed gate/precheck jumps, retryable exact-binding retries, idempotent receipt display, and receipt link safety;
- exit ② and sanitized export regression behavior.

All component and browser fixtures use the typed public daemon shapes. No fixture contains a real GitHub credential or points a mutation at GitHub. Browser QA is a validation item when the local UI plus mocked-daemon harness is runnable: inspect Settings and single/batch publication at narrow and desktop widths, keyboard through the form/wizard/dialog, and verify mocked network payloads. If the harness cannot run in the environment, record the concrete skip reason and rely on the passing component/type/build gates; never substitute a live GitHub repository.

Alternative: require a real daemon with GitHub authentication for QA. Rejected because UI verification must not create an external fork, branch, push, or PR.

## Risks / Trade-offs

- **[Blocked status may omit the configured slug]** → Render only provided safe facts, never a cached guess; keep re-entry/clear available and document the status as unavailable rather than unconfigured.
- **[A preview expires while the user reads it]** → Show expiry, disable confirmation when locally expired, and handle the authoritative server freshness code by requiring a new preview.
- **[Target or review changes after preview]** → Never reuse the old confirmation; discard the snapshot and return through preview.
- **[Retry accidentally creates a second client operation]** → Preserve and resend the exact ref/revision/digest; never call preview for a retryable delivery error.
- **[Fork creation surprises the user]** → Show predicted push repository in status and preview, then call it out again in a dedicated final confirmation.
- **[Single/batch consolidation makes the wizard large]** → Keep selection differences outside the wizard and split presentation-only subcomponents (status, preview summary, refusal list, receipt) without introducing a second state machine.
- **[Status copies expose implementation detail]** → Use only safe public fields and curated issues; never render `TargetSummary.url`, unknown JSON, local paths, commands, or raw error values.
- **[Multiple hook instances briefly disagree]** → Status is refreshed on mount and after mutation; the daemon revision and submit binding remain authoritative, so no optimistic shared cache is required.
- **[Browser QA is unavailable in CI/local runtime]** → Make it evidence-based and conditional, while typecheck/build/Vitest and mocked network assertions remain mandatory.

## Migration Plan

This is a hard development-time replacement, not a migration.

1. Replace publication API types/client methods and add the status hook.
2. Replace the Settings data-repository block with target management and exhaustive safe status rendering.
3. Rebuild `PublishWizard` around the unified preview/confirm/submit contract and real receipt.
4. Wire both single and batch exit cards to the same wizard; delete the batch wrapper and every manual/legacy publication path.
5. Update focused tests and fixtures, run UI/package/workspace gates and the legacy/privacy scans, then perform mocked-daemon browser QA when runnable.

There is no old state import or fallback. Rollback before portfolio delivery is a commit revert of this UI child together with the dependent backend/publisher children if necessary. No automated step touches a real GitHub repository.

## Open Questions

None within this child. The production target repository and final dataset policy remain pre-launch product decisions; the UI intentionally renders whatever compatible target the daemon reports rather than hard-coding an “official” repository.
