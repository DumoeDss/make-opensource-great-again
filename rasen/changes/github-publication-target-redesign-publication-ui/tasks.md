## 1. Typed publication client contract (`packages/ui/src/api/**`)

- [x] 1.1 Replace `PublishPreflight`, single/batch plan/stage/submit types, synthetic receipts, and legacy `PublishError` with exact UI mirrors of the committed `PublicationStatus`, target/manifest/issue summaries, `PublicationPreview`, `PublicationReceipt`, safe gate/refusal attribution, and `PublicationErrorBody`.
- [x] 1.2 Add a discriminated `PublicationResult<T>` and one publication-response parser that preserves only valid stable error fields and maps malformed/network failures to generic local copy without stringifying raw payloads.
- [x] 1.3 Replace `getPreflight`, `publishPlan|Stage|Submit`, and `publishBatchPlan|Stage|Submit` on `ApiClient`/`apiClient` with inspect/configure/clear/preview/submit methods over the five committed `/api/publish` routes.
- [x] 1.4 Make every publication mutation use a relative same-origin URL and `application/json`; assert configure sends only `{ repository }`, preview only `{ reviewIds }`, submit only `{ publicationRef, targetRevision, contentDigest, confirmPublic: true }`, and clear has no body.
- [x] 1.5 Extend `apiClient.test.ts` with success/error fixtures for all five routes, strict method/header/body assertions, optional safe error attribution, DELETE-without-body, and canaries proving raw token/path/command/stderr fields are not surfaced.
- [x] 1.6 Add reusable daemon-contract fixtures/builders for direct, existing-fork, on-submit-fork, blocked-with/without-target, preview, receipt, and stable errors so component tests consume one exact public shape.

## 2. Server-owned publication status (`packages/ui/src/lib` and presentation components)

- [x] 2.1 Delete `src/lib/usePreflight.ts` and add `usePublication.ts` with separate request load state, exact `PublicationStatus|null`, safe error, pending mutation, `refresh`, configure, and clear actions; persist or derive no target/readiness state.
- [x] 2.2 Implement an exhaustive shared publication-status presentation that renders unconfigured, login-required, fork-confirmation-required, ready/direct, ready/fork, and blocked states from the discriminant and shows only available safe facts.
- [x] 2.3 Ensure `fork_confirmation_required` is preview-enabled while unconfigured/login-required/blocked/loading/transport-error are disabled; keep loading/transport failure out of the five-state domain model.
- [x] 2.4 Handle `blocked.target` absence without reusing a draft or previous target, and omit `TargetSummary.url`, local paths, remotes, commands, tokens, raw output, and unknown error objects from every status presentation.
- [x] 2.5 Add hook/status tests covering all five states, refresh replacement, configure/clear returned status, mutation failures, transport failure, optional target, long slug/hash wrapping hooks, and safe-field/leak canaries.

## 3. Editable GitHub target in Settings

- [x] 3.1 Replace the read-only data-repository/`--data-repo` block in `SettingsPage.tsx` with a labeled single `owner/repo` form, lightweight format feedback, Save/validate, Refresh, and Clear actions wired to `usePublication`.
- [x] 3.2 Render status badge and available actor, canonical upstream slug, default branch/base commit, target revision, direct/fork push route/repository, and compatibility kind/contract/schema/license as an accessible definition list; never render the target URL field.
- [x] 3.3 Add pending/disabled states, live success/status text, `role="alert"` failures, and a Clear confirmation explaining preview invalidation and that existing remote forks/branches/PRs are not deleted.
- [x] 3.4 Preserve all theme, daemon-health, provider CRUD, and write-only provider-key behavior and keep the existing responsive token/component style rather than redesigning the page.
- [x] 3.5 Replace Settings tests that mock preflight with exact status fixtures and cover save request, HTTP-success-but-blocked status, invalid target, refresh, clear/no body, all readiness states, blocked-without-target, keyboard labels, and absence of legacy/path/URL/token/raw-error text.

## 4. One preview-to-submit wizard for every selection

- [x] 4.1 Rewrite `PublishWizard.tsx` to accept `reviewIds: string[]` and use one explicit previewing/preview-ready/confirming/submitting/succeeded/retryable-error/re-preview state machine for N=1 and N>1.
- [x] 4.2 Implement read-only preview loading, timeout/progress UX, `expiresAt` display and local expiry guard, while retaining daemon error/expiry as authority and never persisting a preview across component or daemon restart.
- [x] 4.3 Build responsive purpose-specific preview sections for upstream versus push repository, direct/fork and provision mode, public-fork intent, base branch/commit, branch, PR title/body, counts/bytes/digest, repository-relative file kind/path/bytes/hash, and engine pins in an Advanced fold.
- [x] 4.4 Render `precheck_refused` as review/session/rule counts only and wire per-review/per-rule actions; handle `review_not_found`/`GATE_LOCKED` with an attributed return-to-review callback and no raw match or exact record display.
- [x] 4.5 Add a dedicated Radix-based public-publication confirmation that repeats upstream, push repository, record count, and public-fork creation effect; cancellation performs no submit.
- [x] 4.6 On confirmation submit only the exact preview ref/revision/digest plus literal `confirmPublic: true`; accept no editable branch, fork, path, remote, URL, token, or command value.
- [x] 4.7 For `preview_not_found|preview_expired|preview_stale|target_changed`, discard the preview, refresh status, and require a new preview/confirmation; never automatically resubmit a replacement snapshot.
- [x] 4.8 For retryable delivery errors, retain and retry the exact same ref/revision/digest; for non-retryable target/workspace/branch errors show curated recovery and require a new preview whenever sealed assumptions cannot be reused.
- [x] 4.9 Render the real receipt with safe PR link/new-tab attributes, PR number, upstream/push/mode, base branch/commit, contribution branch/commit, target revision, record count, digest, and time, then trigger the existing journey completion callback without replacing the receipt with a boolean.
- [x] 4.10 Add shared wizard tests for N=1 and N>1, direct/existing-fork/on-submit-fork previews, file commitments, public-confirm cancel/confirm, exact submit body, local/server expiry, daemon-restart lost ref, stale target/content, attributed gate/precheck jumps, exact-binding retries, idempotent receipt display, link safety, and forbidden-field canaries.

## 5. Single/batch exit integration and legacy component deletion

- [x] 5.1 Update `ExitCards.tsx` exit ① to consume publication status, show the safe target route, enable only ready/fork-confirmation states, and open the shared wizard with `[reviewId]`; leave exit ② and sanitized export unchanged.
- [x] 5.2 Update `BatchExitCards.tsx` exit ① to consume the same status and open the same wizard with all queue review IDs; preserve `BatchSubmitPanel`, per-item/download-all export, and existing queue copy/count behavior.
- [x] 5.3 Update `ReviewView.tsx` publication callbacks as needed so attributed errors return to the correct review/rule through the affirmation-void guard and a real single/batch publication receipt still marks the existing journey complete.
- [x] 5.4 Delete `BatchPublishWizard.tsx` and `BatchPublishWizard.test.tsx`; move every still-valid N>1 assertion into the shared wizard/integration tests rather than retaining a wrapper or alias.
- [x] 5.5 Delete manual stage buttons/state, staged-file location panels, command-copy renderers, compare links, Git/`gh` readiness copy, dirty-worktree guidance, and every import/test fixture that exists only for that surface.
- [x] 5.6 Update `PublishWizard.test.tsx`, `BatchExitCards.test.tsx`, `ReviewView.test.tsx`, `AppShell.test.tsx`, `SessionPicker.test.tsx`, `smoke.test.tsx`, and other `ApiClient` fakes to the new exact methods with no compatibility stubs.
- [x] 5.7 Add regression assertions that the queue-wide donation affirmation still gates the first exit action, final public confirmation remains separate, exit ② direct-submit behavior is unchanged, and single/batch sanitized export remains available when GitHub publication is not ready.

## 6. Accessibility, responsiveness, and privacy review

- [x] 6.1 Reuse existing Button/Input/Badge/Dialog/AdvancedFold tokens and layouts; add no parallel design system, unnecessary dependency, raw-JSON primary view, or unrelated navigation change.
- [x] 6.2 Add/verify programmatic labels and descriptions, visible focus, logical keyboard order, Radix focus trap/restore, `aria-live` progress/status, `role="alert"` errors, and text/icon cues that do not rely on color alone.
- [x] 6.3 Verify narrow layouts stack controls and target facts, long slugs/hashes wrap, and file commitments scroll within a bounded container without clipping actions or causing page-wide overflow.
- [x] 6.4 Add DOM canary tests across Settings/status/preview/error/receipt fixtures proving no workspace or absolute path, data-repository path, remote URL/name, command, token, stdout/stderr, raw external message, or exact `files[].contents` is rendered.

## 7. Focused and repository verification

- [x] 7.1 Run the focused publication client/hook/Settings/wizard/single/batch/ReviewView Vitest files and fix every failure, including tests that prove no real GitHub write URL or credential is present in the UI harness.
- [x] 7.2 Run `npm run typecheck -w @mosga/ui` and `npm run build -w @mosga/ui`, then run the complete UI test set.
- [x] 7.3 Run repository `npm run typecheck`, `npm run build`, and the complete Vitest suite with the repository timeout; fix every regression caused by the hard deletion.
- [x] 7.4 Run a live-source/test legacy scan proving `PublishPreflight`, `usePreflight`, `dataRepoPath`, `dataRepoConfigured`, `--data-repo`, old plan/stage/batch routes/methods, manual fallback, emitted commands, and compare-URL publication UI are absent.
- [x] 7.5 Run a publication privacy scan proving UI source contains no workspace/path/remote/token/raw-output response rendering and confirm every publication request body is limited to the committed authority fields.
- [x] 7.6 When the local UI plus mocked-daemon harness is runnable, perform browser QA at desktop and narrow widths for Settings plus single/batch preview/confirm/receipt, keyboard and focus behavior, and mocked network payloads; otherwise record the exact runtime constraint. In either case, never authenticate to or write a real GitHub repository.
- [x] 7.7 Run `git diff --check` and strict Rasen validation for `github-publication-target-redesign-publication-ui`; audit that implementation edits are limited to `packages/ui/**` and this child's artifacts, with no daemon/publisher/template/config/remote mutation.
