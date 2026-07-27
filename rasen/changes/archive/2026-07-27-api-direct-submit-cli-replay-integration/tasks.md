## 1. Package scaffold and public contracts

- [x] 1.1 Scaffold `@mosga/replay-submit` as an ESM/tsup workspace package depending only on `@mosga/contracts`, `@mosga/replay-bundle`, `@mosga/replay-runtime`, and `@mosga/replay-proxy`; place it after `@mosga/replay-proxy` in root build/typecheck order.
- [x] 1.2 Add `CliResumeConsentSchema`, `CliResumeReceiptSchema`, `CliResumeSubmitFailureSchema`, `CliResumeSubmitErrorCode`, `CliResumeConsent`, and `CliResumeReceipt` to `@mosga/contracts`; export them from the contracts index. Do not modify existing schemas.
- [x] 1.3 Define the `@mosga/replay-submit` public surface: `submitCliResume`, `renderTerminalManifest`, `CliResumeSubmitParams`, `CliResumeSubmitResult`, `RenderTerminalManifestInput`, and the re-exported consumed types.
- [x] 1.4 Add a package-surface test asserting only the high-level orchestration types are exported, no `@mosga/direct-submit` import is reachable, and no sanitizer, reconstructed-request builder, or direct `submit` function is exposed.

## 2. Terminal-manifest renderer

- [x] 2.1 Implement `renderTerminalManifest(input)` as a pure function producing the terminal user message: a short `ACK`-only preamble followed by a `<mosga-session-context>` JSON block.
- [x] 2.2 Map the seed's `SafeSourceSummary` into the `source` section, augmented with `replayCliVersion` from the observation (keeping the seed's `recordedCliVersion` separate).
- [x] 2.3 Map the seed's `ReplayTrajectory` counts into the `trajectory` section, and derive the `omissions` array from the bundle's reviewed `ReplayOmission[]` (category + disclosure text).
- [x] 2.4 Map the seed's `SanitizationProvenance` into the `sanitization` section, augmented with `humanReviewPassed` and `bundleContentHash`.
- [x] 2.5 Map the seed's runtime/delivery/policy fields and the consent acknowledgment subset into their respective JSON sections.
- [x] 2.6 Add tests asserting deterministic byte-identical output for identical inputs, canonical JSON key order, LF endings, presence of `replayCliVersion` / `bundleContentHash` / omissions / `humanReviewPassed`, and absence of any data not in the explicit inputs.

## 3. Consent validation

- [x] 3.1 Implement `assertCliResumeConsent(consent, payload, bundleContentHash)` that validates all acknowledgments are true, the bundle hash matches, and target / mode / instruction policy / skill policy match the sealed bundle payload.
- [x] 3.2 Add tests for every validation branch: missing consent, each acknowledgment false, hash mismatch, provider mismatch, model mismatch, mode mismatch, instruction-policy mismatch, skill-policy mismatch, and a valid consent that passes.

## 4. Bundle extraction

- [x] 4.1 Implement `extractValidatedBundle(bundle)` that calls `validateReplayBundle`, reads the integrity `contentHash` from the validated input, and returns `{ payload, bundleContentHash }`. Fail closed on any integrity error with a stable `bundle-invalid` code.
- [x] 4.2 Add tests asserting the extracted payload matches the sealed content, the hash is the domain-separated `sha256:` root, and a mutated / legacy-hash / unsupported-version bundle fails closed.

## 5. Orchestration function

- [x] 5.1 Implement `submitCliResume(params)` following the locked order: extract bundle → validate consent → `runtime.prepare` → verify hash identity → render manifest → `proxy.registerRoute` → `prepared.execute` → await proxy receipt → merge receipt → dispose (finally).
- [x] 5.2 Implement the `finally` disposal that calls both `prepared.dispose()` and `handle.dispose()` idempotently on every exit path, and records cleanup state in the failure result.
- [x] 5.3 Implement the receipt merger that combines `ReplayPreparationObservation` + `ReplayProxyReceipt` + consent into `CliResumeReceipt`, mapping the outcome correctly (`inference-served` / `upstream-non-2xx` / `upstream-request-failed` / `runtime-failed`).
- [x] 5.4 Implement the partial-failure path: when `execute` returns `ok: false` but the proxy receipt resolved, record `outcome: 'runtime-failed'` alongside the real hashes and HTTP status.
- [x] 5.5 Implement the failure taxonomy: map runtime failures (`cli-version-unsupported`, `cli-capability-unsupported` → `runtime-unsupported`; other runtime codes → `runtime-failed`), proxy failures → `proxy-failed` / `upstream-failed`, cancellation → `cancelled`, timeout → `timed-out`.
- [x] 5.6 Add tests for: successful round-trip with all three hashes, every runtime failure code, every proxy failure code, cancellation mid-execute, timeout, partial failure (runtime fails but proxy receipt resolves), dispose-on-every-path, and double-dispose idempotency.

## 6. No-fallback guarantee

- [x] 6.1 Add a source-scan test proving `@mosga/replay-submit` cannot import `@mosga/direct-submit`, any reconstructed-request builder, or any direct `submit` function.
- [x] 6.2 Add a runtime-fallback test proving that every injected failure returns `{ ok: false }` and never invokes a reconstructed path, alternate converter, or retry.
- [x] 6.3 Add a disclosure-canary test proving the route token, upstream key, system-prompt canary, tool-schema canary, terminal-meta canary, and skill-description canary never appear in any receipt, failure result, or log across every code path.

## 7. Daemon submit-route branching

- [x] 7.1 Extend the `POST /api/reviews/:reviewId/submit` handler to branch on `consent.replayMode`: `cli-resume` → `submitCliResume`; `single-shot` / `turn-by-turn` → existing `submit()`.
- [x] 7.2 Add the `CliResumeSubmitBody` zod schema validating `{ providerId, model, consent: CliResumeConsentSchema, bundle }` for the cli-resume branch.
- [x] 7.3 Resolve the upstream target and key from the same `resolveProvider` / `resolveProviderKey` / `providerStore` used by the reconstructed path; pass them as `ReplayUpstreamTarget`.
- [x] 7.4 Create one `ReplayRuntime` and one `ReplayProxy` at app construction (injectable via `AppOptions` for tests) and pass them to `submitCliResume`.
- [x] 7.5 Map `submitCliResume` failures to stable HTTP codes: `CONSENT_INVALID` (422), `BUNDLE_INVALID` (422), `RUNTIME_UNSUPPORTED` (422 with source CLI + version), `RUNTIME_FAILED` (500), `PROXY_FAILED` (500), `KEY_NOT_CONFIGURED` (400), `SUBMIT_FAILED` (500 generic).
- [x] 7.6 Add daemon tests: cli-resume success returns a `CliResumeReceipt`; compat mode is unchanged; cli-resume failure returns the right code and does not call `submit()`; `KEY_NOT_CONFIGURED` for a missing key.

## 8. Replay preparation daemon routes

- [x] 8.1 Add `POST /api/reviews/:reviewId/replay/prepare` that retrieves the held review's source-session ref, calls `adapter.captureNativeSession(ref)`, and fails closed on capture errors.
- [x] 8.2 Implement instruction-candidate discovery from the project directory (scan for `CLAUDE.md` / `AGENTS.md` using the adapter's project ref and documented scoping rules; supply explicit candidates to `createReplayDraft`).
- [x] 8.3 Build the `TerminalManifestSeed` and fixed v1 `ReplayRuntimePolicy` from the capture's safe source summary, trajectory, sanitization provenance, and the user-chosen delivery target.
- [x] 8.4 Call `createReplayDraft` → `scanReplayDraft(draft, ruleset)` → store draft + scan result + mapper in the review state. Return the replay scan report.
- [x] 8.5 Add replay-finding disposition endpoints (or extend existing ones) that operate on the replay scan report and recompute the replay gate via `computeReplayGate`.
- [x] 8.6 Add `POST /api/reviews/:reviewId/replay/seal` that requires an unlocked replay gate, calls `applyReplayDispositions` + `sealReplayBundle`, stores the sealed bundle in the review state, and returns the bundle hash + summary.
- [x] 8.7 Add daemon tests: preparation creates a draft and scan; capture failure surfaces; sealing requires unlocked gate; sealed bundle is consumable by the submit route.

## 9. UI mode selector and extended consent

- [x] 9.1 Extend `SubmitPanel` with a mode selector defaulting to `cli-resume`; group `single-shot` / `turn-by-turn` under a "Compatibility: reconstructed API" label.
- [x] 9.2 Add the `runtimeContextAcknowledged` checkbox for cli-resume mode, disclosing that the source CLI dynamically adds system prompt, tools, and skill descriptions that are not rescanned.
- [x] 9.3 Build the `CliResumeConsent` record from the UI state and the bundle hash from the replay-preparation step.
- [x] 9.4 Extend the receipt display to show all three hashes, converter id/version, source and replay CLI versions, and capability profile for cli-resume receipts. Preserve the existing receipt display for compat mode.
- [x] 9.5 Surface `RUNTIME_UNSUPPORTED` failures with the CLI name, version, and an actionable message (install or update the required CLI).
- [ ] 9.6 Add UI tests: mode selector switches consent fields; cli-resume consent requires all three acknowledgments; receipt display shows three hashes; unsupported-version error renders actionable detail.

## 10. End-to-end and compatibility tests

- [x] 10.1 Add an end-to-end daemon test: prepare → seal → submit via cli-resume with a fake runtime + fake proxy + fake upstream, asserting the full receipt carries all three hashes and the correct converter.
- [x] 10.2 Add a compatibility test: submitting under `single-shot` with the existing consent shape produces the existing `SubmissionReceipt` unchanged.
- [x] 10.3 Add a no-fallback daemon test: inject a failing fake runtime and assert the handler returns an error without calling `submit()` from `@mosga/direct-submit`.
- [ ] 10.4 Add a disclosure end-to-end test: assert the route token, upstream key, system-prompt canary, and tool-schema canary are absent from every HTTP response, receipt, and error across success and failure paths.
- [x] 10.5 Add an unsupported-version end-to-end test: inject a fake runtime that returns `cli-version-unsupported` and assert the daemon returns 422 with `RUNTIME_UNSUPPORTED`, the CLI name, and the version.

## 11. Documentation and repository gates

- [x] 11.1 Document the `@mosga/replay-submit` package's public `submitCliResume` / `renderTerminalManifest` handoff, the no-fallback guarantee, and the three-hash receipt model.
- [ ] 11.2 Update the office-hours design status and the change design's acceptance-criteria checklist to reflect the shipped cli-resume path.
- [ ] 11.3 Update the daemon README with the cli-resume submit flow, the replay-preparation routes, and the error-code table.
- [x] 11.4 Run `@mosga/replay-submit` focused tests, then `@mosga/contracts`, `@mosga/replay-bundle`, `@mosga/replay-runtime`, `@mosga/replay-proxy`, `@mosga/direct-submit`, `@mosga/daemon`, and `@mosga/ui` focused suites to confirm no regression.
- [x] 11.5 Run repository-wide typecheck, test, and build commands and resolve any package export, build-order, or platform regression.
- [x] 11.6 Run `rasen validate api-direct-submit-cli-replay-integration --strict` and resolve any validation errors.
