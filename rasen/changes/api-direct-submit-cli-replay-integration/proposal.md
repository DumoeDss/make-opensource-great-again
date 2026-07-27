## Why

The shipped `@mosga/replay-bundle`, `@mosga/replay-runtime`, and
`@mosga/replay-proxy` packages now provide every isolated building block the
office-hours design requires: a sealed, validated bundle; a two-phase replay
runtime that materializes it and drives a source CLI; and a one-shot loopback
proxy that isolates credentials and hashes both request bodies. But nothing in
the repository connects these three to the submit path a user actually drives:
the daemon's `/api/reviews/:reviewId/submit` still routes every submission
through `@mosga/direct-submit`'s reconstructed-API builder, the terminal
metadata still uses the limited `ContributionMeta` shape, consent still binds
only the legacy session hash, and receipts still carry a single content hash.
The authenticity guarantee the portfolio was decomposed to deliver — the
outbound request is assembled by the source CLI — is unreachable from
production code.

## What Changes

- Add a focused `@mosga/replay-submit` package that owns the cli-resume
  orchestration boundary: it validates cli-resume consent against the sealed
  bundle, drives the locked `prepare → render terminal manifest → register
  proxy route → execute → dispose` order, and merges the runtime observation
  with the proxy receipt into one extended receipt carrying all three hashes.
- Add a deterministic terminal-manifest renderer that combines the bundle's
  sealed `TerminalManifestSeed`, the bundle's reviewed omissions, the
  runtime-observed replay CLI version, the validated bundle content hash, the
  review-evidence `humanReviewPassed` flag, and a separately validated consent
  subset into the sole terminal user message. The renderer adds no data that is
  not already in the sealed bundle or the observation; it never rereads raw
  session metadata.
- Add an extended consent shape (`CliResumeConsent`) that binds the target
  provider, target model, replay mode, runtime policy, instruction policy,
  skill policy, the validated bundle content hash, and a runtime-context
  acknowledgment that the source CLI will dynamically add its own system
  prompt, tool definitions, and skill descriptions.
- Add an extended receipt shape (`CliResumeReceipt`) that converges all three
  hashes — bundle content hash (from the runtime observation), CLI-request
  hash, and outbound-request hash (from the proxy receipt) — alongside the
  converter id/version, HTTP status, usage, source and replay CLI versions,
  capability profile, and the accepted consent.
- Extend the daemon submit route to branch on the consent's replay mode:
  `cli-resume` submissions go through `@mosga/replay-submit`; existing
  `single-shot` / `turn-by-turn` submissions continue through
  `@mosga/direct-submit`, now explicitly labeled as the reconstructed-API
  compatibility path. A cli-resume failure is terminal and never falls back to
  reconstructed API.
- Surface the runtime's unsupported-version / unsupported-capability result as
  a terminal failure with a stable error code; do not broaden the supported
  predicates or retry an alternate invocation.
- Add a replay-preparation daemon route that produces a sealed `ReplayBundle`
  from a review's source session by consuming the bundle foundation's public
  `createReplayDraft` / `scanReplayDraft` / `applyReplayDispositions` /
  `sealReplayBundle` APIs and the session-readers' native capture path.
- Update the UI submit panel to expose cli-resume as the default mode,
  reconstructed-API as an explicitly named compatibility choice, the extended
  consent acknowledgments, and the three-hash receipt.
- Add end-to-end tests (fake runtime + fake proxy + fake upstream),
  compatibility tests (reconstructed-API path unchanged), a no-fallback
  guarantee test, and documentation.

## Capabilities

### New Capabilities

- `replay-submit`: cli-resume orchestration, deterministic terminal-manifest
  rendering, cli-resume consent validation, three-hash receipt assembly, and
  stable disclosure-safe failure contracts.

### Modified Capabilities

- `direct-submit`: the reconstructed-API path is explicitly labeled as a
  compatibility mode; it MUST NOT be used as an automatic fallback when
  cli-resume fails.
- `review-daemon`: the submit route branches on replay mode without silent
  fallback; a replay-preparation endpoint produces a sealed bundle from a
  review's source session.

## Impact

- Adds a focused `@mosga/replay-submit` package depending on `@mosga/contracts`,
  `@mosga/replay-bundle` (validator + types), `@mosga/replay-runtime`, and
  `@mosga/replay-proxy`. It deliberately does NOT depend on
  `@mosga/direct-submit`: the structural separation preserves the no-fallback
  guarantee at the import-graph level.
- Modifies `@mosga/contracts` to add the cli-resume consent and receipt schemas
  and the extended replay-mode enum value. Existing consent/receipt schemas and
  the existing `single-shot` / `turn-by-turn` modes remain unchanged for the
  compatibility path.
- Modifies `@mosga/daemon` (`app.ts`) to add the cli-resume submit branch and a
  replay-preparation route. The existing reconstructed-API submit path,
  estimate, provider, and review routes are preserved.
- Modifies `@mosga/ui` (`SubmitPanel.tsx` and API types) to expose the mode
  selector, extended consent acknowledgments, and the extended receipt.
- Does NOT modify `@mosga/replay-bundle`, `@mosga/replay-runtime`, or
  `@mosga/replay-proxy` source — their public APIs are consumed as-is.
- Adds the final convergence point of the portfolio: the three hashes, the
  terminal manifest, and the no-fallback boundary all meet here.
