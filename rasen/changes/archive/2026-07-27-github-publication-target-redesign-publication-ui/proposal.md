## Why

The approved office-hours design makes the public-contribution destination a canonical GitHub repository, but the current UI still asks the removed local-clone preflight model whether `--data-repo`, Git, `gh`, and a clean working tree are available. The UI must now consume the committed publication backend as its single source of truth, let the user manage one `owner/repo` target, and make the public fork/PR effects explicit before confirmed submit.

## What Changes

- **BREAKING** Delete the UI `PublishPreflight` booleans, old single/batch plan-stage-submit client methods, `usePreflight`, manual command/compare-URL fallback, and the separate batch publication wizard.
- Replace the read-only “data repository / `--data-repo`” settings block with an editable single GitHub publication target that can inspect, configure, clear, and refresh canonical `owner/repo` readiness.
- Consume the daemon’s discriminated `unconfigured | login_required | fork_confirmation_required | ready | blocked` status directly, including the safe actor, canonical upstream, default branch, direct/fork push route, fork-creation intent, target revision, compatibility summary, and curated issues.
- Use one responsive and accessible `PublishWizard` for both one and many `reviewIds`: create an expiring preview, show its exact safe target/PR/file commitments, obtain an explicit public-PR confirmation (including public fork creation when applicable), then submit the exact `publicationRef`, target revision, and content digest.
- Treat preview loss, expiry, stale content, and target changes as “preview again” conditions; retain stable retry for retryable submit errors and display the real idempotent PR receipt with URL, commit, branch, target, count, digest, and time.
- Preserve exit ② direct submission and the sanitized-file-only fallback without changing their API or consent semantics.
- Keep the existing UI design system and journey structure; add focused typed-client and component tests plus mocked-daemon browser QA, with no real GitHub write.
- This is a development-time hard replacement: no migration, compatibility wrapper, legacy endpoint, or legacy UI state is retained.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `publish-exit-one`: Replace local-clone/preflight/plan-stage-submit publishing with status-driven GitHub target readiness, one sealed preview-to-confirmed-submit wizard, stable recovery behavior, and a real PR receipt.
- `ui-batch-exits`: Make N>1 publication use the same `reviewIds` wizard and response contracts as N=1 while preserving batch direct submit and sanitized export.
- `ui-journey-shell`: Make Settings manage one GitHub publication target and extend the existing exit/summary presentation to safe publication previews and receipts without changing the shell, theme, provider, or donation-affirmation behavior.

## Impact

- Primary scope: `packages/ui/src/api/{types,client}.ts`, a replacement publication hook, `SettingsPage`, `PublishWizard`, single/batch exit cards, `ReviewView` receipt wiring where needed, and focused UI tests.
- Deleted scope: `packages/ui/src/lib/usePreflight.ts`, `BatchPublishWizard.tsx`, obsolete plan/stage/manual-fallback types and client methods, and their legacy tests/fixtures.
- Backend contract consumed without modification: `GET /api/publish`, `PUT|DELETE /api/publish/target`, `POST /api/publish/preview`, and strict `POST /api/publish/submit`.
- Security/privacy: the UI never accepts or renders a workspace path, local repository path, remote URL/name, token, command, raw stdout/stderr, exact contribution contents, or uncurated external error text.
- Source context: `rasen/office-hours/github-publication-target-redesign.md`, the parent planning context, and the committed/CLEAN publication-backend artifacts and public TypeScript contracts.
