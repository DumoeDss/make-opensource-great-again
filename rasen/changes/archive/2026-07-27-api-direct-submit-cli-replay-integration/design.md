## Context

The portfolio decomposed the office-hours replay design into four serial
children. The first three are shipped:

```text
bundle (9f9d7c5) -> runtime (1088b89) -> proxy (b8482a5) -> integration
```

Each shipped child established a focused, tested, independently validated
boundary:

- `@mosga/replay-bundle` exports `createReplayDraft`, `sealReplayBundle`,
  `validateReplayBundle`, and the canonical serializers. The sealed bundle
  carries a `TerminalManifestSeed`, reviewed omissions, review evidence, and a
  domain-separated `sha256:` content hash.
- `@mosga/replay-runtime` exports `createReplayRuntime` with a two-phase
  `prepare → execute → dispose` lifecycle. Preparation calls
  `validateReplayBundle` itself, probes the installed CLI, selects a capability
  profile, materializes a private workspace, and returns a non-secret
  `ReplayPreparationObservation` (validated bundle hash, recorded/replay CLI
  versions, capability profile, sealed delivery target, route requirement).
- `@mosga/replay-proxy` exports `createReplayProxy` with
  `registerRoute → ReplayRouteHandle{binding, receipt, dispose}` and
  `shutdown`. The proxy holds the real upstream key, serves one loopback
  route, converts protocols structurally, enforces one inference request, and
  returns a `ReplayProxyReceipt` carrying `cliRequestHash` and
  `outboundRequestHash`.

The locked orchestration order (from the runtime child) is:

```text
prepare -> render terminal manifest -> register proxy route -> execute -> dispose
```

The runtime child's handoff states this order is load-bearing: the manifest
needs the observed CLI version, the proxy needs the route requirement, and
execution needs both the manifest and the binding.

There is no production caller of these three packages today.
`@mosga/direct-submit` reconstructs provider requests from normalized
`SanitizedSession.messages` and sends them via `fetch`; the daemon's submit
route calls that `submit()` directly. The current terminal message uses the
limited `ContributionMeta` shape (not the sealed seed), consent binds only the
legacy session hash, and receipts carry a single `contentHash`. The
authenticity guarantee — the outbound request is assembled by the source CLI —
is unreachable.

## Goals / Non-Goals

**Goals:**

- Provide one public cli-resume orchestration function that drives the locked
  `prepare → render → register → execute → dispose` order, consumes the three
  shipped packages' public APIs, and returns a single extended receipt.
- Render the sole terminal user message deterministically from the sealed
  `TerminalManifestSeed`, the bundle's reviewed omissions, the review-evidence
  `humanReviewPassed` flag, the validated bundle content hash, the
  runtime-observed replay CLI version, and a consent acknowledgment subset —
  with zero raw-session rereading.
- Bind cli-resume consent to the validated bundle content hash, target
  provider, target model, replay mode, runtime/instruction/skill policy, and a
  runtime-context acknowledgment.
- Merge the three hashes (bundle content hash from the runtime observation;
  CLI-request and outbound-request hashes from the proxy receipt) into one
  extended receipt that also records converter id/version, HTTP status, usage,
  source and replay CLI versions, capability profile, timing, and consent.
- Make `cli-resume` the default submit mode in the daemon and UI while keeping
  the existing `single-shot` / `turn-by-turn` modes explicitly labeled as the
  reconstructed-API compatibility path.
- Enforce the no-fallback guarantee both structurally
  (`@mosga/replay-submit` does not import `@mosga/direct-submit`) and at
  runtime (a cli-resume failure is terminal).
- Surface the runtime's unsupported-version / unsupported-capability result as
  a terminal failure; never broaden the supported predicates or retry an
  alternate invocation.
- Add a daemon replay-preparation route that produces a sealed `ReplayBundle`
  from a review's source session by consuming the bundle foundation's public
  APIs and the session-readers' native capture path.
- Prove the boundary with fake runtime/proxy/upstream injections, end-to-end
  fake round-trips, compatibility tests, and a no-fallback guarantee test.

**Non-Goals:**

- Modifying `@mosga/replay-bundle`, `@mosga/replay-runtime`, or
  `@mosga/replay-proxy` source — their public APIs are consumed as-is.
- Rescanning, resanitizing, rewriting, or truncating any session, instruction,
  prompt, skill, or response content inside the orchestration path.
- Providing a second sanitizer, prompt scanner, or content-rewrite pass.
- Reproducing an historical CLI build or guaranteeing byte-identical wire
  requests across protocol conversion.
- Adding new protocol converters, CLI adapter profiles, or provider presets.
- Validating that a provider uses data for training, bypassing ToS, or
  guaranteeing full trajectory survival inside the context window.

## Decisions

### 1. Add a focused `@mosga/replay-submit` package

The package depends only on `@mosga/contracts`, `@mosga/replay-bundle`
(validator + types), `@mosga/replay-runtime`, and `@mosga/replay-proxy`. It
deliberately has NO dependency on `@mosga/direct-submit`: the structural
separation preserves the no-fallback guarantee at the import-graph level. A
package-surface test asserts this.

Proposed internal layout:

```text
packages/replay-submit/src/
├─ index.ts                 public surface only
├─ orchestrate.ts           prepare → render → register → execute → dispose
├─ manifest.ts              deterministic terminal-manifest renderer
├─ consent.ts               cli-resume consent validation
├─ receipt.ts               three-hash receipt assembly
├─ bundleExtract.ts         validated-bundle extraction (seed, omissions, hash)
├─ errors.ts                stable safe failure/result model
└─ __tests__/               focused tests with fakes
```

Alternative considered: place the orchestration inside the daemon. Rejected
because the daemon already imports `@mosga/direct-submit` (for the compat
path), so in-daemon orchestration would make the reconstructed path statically
reachable from the cli-resume code. A separate package enforces the boundary
structurally.

### 2. Export one orchestration function with injectable boundaries

The public surface:

```ts
export interface CliResumeSubmitParams {
  readonly bundle: unknown;
  readonly consent: CliResumeConsent;
  readonly upstream: ReplayUpstreamTarget;
  readonly skillRoots?: readonly ReplaySkillRoot[];
  readonly runtime?: ReplayRuntime;
  readonly proxy?: ReplayProxy;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type CliResumeSubmitResult =
  | { readonly ok: true; readonly receipt: CliResumeReceipt }
  | { readonly ok: false; readonly error: CliResumeSubmitFailure };

export async function submitCliResume(
  params: CliResumeSubmitParams,
): Promise<CliResumeSubmitResult>;
```

`runtime` and `proxy` are optional injection seams. In production the daemon
creates one `ReplayRuntime` and one `ReplayProxy` and passes them in. In tests,
fakes replace both — no real CLI is launched, no real listener binds, and no
real provider is contacted. The function is the sole public entry point;
internal helpers are non-exported.

Alternative considered: export the individual orchestration steps so the daemon
can call them individually. Rejected because the order is load-bearing and a
single function with mandatory `dispose` in `finally` is the simplest way to
guarantee correct cleanup on every path.

### 3. Orchestration order is the locked sequence with consent first

The function performs:

1. **Extract + validate bundle.** Call `validateReplayBundle(bundle)` to obtain
   the `ReplayBundlePayload` (seed, omissions, review evidence, delivery
   target). Read the integrity `contentHash` from the validated input. This is
   a cheap, self-contained operation with no side effects.
2. **Validate consent.** Assert every acknowledgment is true; assert
   `consent.bundleContentHash` equals the validated hash; assert target,
   mode, and policy fields match the bundle's sealed values. Consent is
   validated BEFORE any expensive side effect (CLI probe, workspace creation).
3. **Prepare runtime.** Call `runtime.prepare({ bundle, skillRoots, signal })`.
   If preparation fails (unsupported CLI version, capability missing, probe
   error), return a terminal failure — never fall back.
4. **Verify hash identity.** Assert
   `observation.bundleContentHash === consent.bundleContentHash`. This is
   defense-in-depth: both values should match because they derive from the
   same validated bundle.
5. **Render terminal manifest.** Call `renderTerminalManifest` with the seed,
   omissions, review flag, observation values, and consent subset. This
   produces the sole terminal input string.
6. **Register proxy route.** Call `proxy.registerRoute` with the observation's
   `routeRequirement` and the upstream target. If registration fails
   (converter unsupported, target mismatch), dispose the prepared replay and
   return a terminal failure.
7. **Execute.** Call `prepared.execute({ terminalInput, route: handle.binding,
   timeoutMs, signal })`.
8. **Await proxy receipt.** The proxy receipt promise resolves after the
   round-trip completes (the CLI exits after receiving the proxied response,
   which normally happens before `execute` returns).
9. **Merge receipt.** Combine the observation, proxy receipt, and consent into
   a `CliResumeReceipt`.
10. **Dispose (always).** `prepared.dispose()` and `handle.dispose()` run in a
    `finally` block regardless of success or failure. Both are idempotent.

If `execute` returns `ok: false` (process exit failure, timeout,
cancellation), the proxy receipt may still resolve (the CLI may have sent the
request before exiting non-zero). The orchestration records the runtime
failure as the outcome but still merges any available proxy receipt hashes.

Alternative considered: render the manifest before prepare so the terminal
input is ready earlier. Rejected because the manifest needs the
runtime-observed `replayCliVersion`, which is only available after prepare.

### 4. Terminal manifest renderer is pure and non-enriching

```ts
export interface RenderTerminalManifestInput {
  readonly seed: TerminalManifestSeed;
  readonly omissions: readonly ReplayOmission[];
  readonly humanReviewPassed: boolean;
  readonly bundleContentHash: `sha256:${string}`;
  readonly replayCliVersion: string;
  readonly consent: CliResumeConsent;
}

export function renderTerminalManifest(
  input: RenderTerminalManifestInput,
): string;
```

The renderer produces the terminal user message in the format specified by the
office-hours design §12: a short preamble instructing `ACK`-only reply,
followed by a `<mosga-session-context>` JSON block. The JSON block carries:

- `kind`, `schemaVersion`, `purpose` — from the seed.
- `source` — from the seed's `SafeSourceSummary`, augmented with
  `replayCliVersion` (from the observation; `recordedCliVersion` is already in
  the seed).
- `trajectory` — counts from the seed, plus an `omissions` array derived from
  the bundle's reviewed `ReplayOmission[]` disclosure strings.
- `sanitization` — provenance from the seed, plus `humanReviewPassed` (from
  review evidence) and `bundleContentHash`.
- `runtime` — replay mode, instruction policy, skill policy, and `proxyRescan:
  false` from the seed.
- `delivery` — target provider and model from the seed.
- `consent` — consent version, the three acknowledgment flags, and
  `confirmedAt` from the consent.

The renderer is deterministic: identical inputs always produce byte-identical
output (canonical JSON key order, LF line endings, no trailing whitespace). It
adds NO data that is not in its explicit inputs. It never reads the original
session file, recomputes trajectory counts, discovers instructions, or adds
source-model information not present in the seed.

Alternative considered: store a pre-rendered terminal message in the bundle.
Rejected because the manifest must carry the runtime-observed CLI version,
which is only known after prepare, and the validated bundle hash, which the
runtime observation confirms.

### 5. Cli-resume consent binds the full policy surface

```ts
export const CliResumeConsentSchema = z.object({
  consentVersion: z.string().min(1),
  tosRiskAcknowledged: z.boolean(),
  fullRetentionAcknowledged: z.boolean(),
  runtimeContextAcknowledged: z.boolean(),
  bundleContentHash: ReplayDigestSchema,
  targetProviderId: z.string().min(1),
  targetModel: z.string().min(1),
  replayMode: z.literal('cli-resume'),
  instructionPolicy: z.literal('sanitized-snapshot'),
  skillPolicy: z.literal('cli-discovery-read-only'),
  confirmedAt: z.string().datetime({ offset: true }),
});
```

All three acknowledgments MUST be true. `runtimeContextAcknowledged` is new:
the user acknowledges that the source CLI will dynamically assemble its own
system prompt, tool definitions, environment context, and discovered skill
descriptions, and that these are NOT rescanned by the proxy.

The consent binds:
- the validated bundle content hash (not the legacy session hash);
- target provider and model (matched against the sealed delivery target);
- replay mode `cli-resume` (matched against the runtime policy);
- instruction and skill policy (matched against the sealed runtime policy).

The orchestration validates consent against the extracted bundle payload
BEFORE calling `runtime.prepare`, because preparation is expensive (CLI probe,
workspace creation) and consent mismatch should fail fast.

Alternative considered: keep the existing `ContributionConsent` and add fields.
Rejected because the legacy consent binds the `SanitizedSession` content hash
and the `single-shot` / `turn-by-turn` modes, which are irrelevant to
cli-resume. A separate schema keeps each path's consent self-consistent.

### 6. Three-hash receipt converges at the orchestration layer

```ts
export const CliResumeReceiptSchema = z.object({
  submittedAt: z.string(),
  sourceCli: SourceCliSchema,
  recordedCliVersion: z.string().nullable(),
  replayCliVersion: z.string(),
  capabilityProfileId: z.string(),
  targetProviderId: z.string(),
  targetModel: z.string(),
  upstreamApiFormat: ReplayApiFormatSchema,
  converterId: z.string(),
  converterVersion: z.string(),
  bundleContentHash: ReplayDigestSchema,
  cliRequestHash: ReplayDigestSchema,
  outboundRequestHash: ReplayDigestSchema,
  requestCount: z.number(),
  httpStatus: z.number(),
  outcome: z.enum([
    'inference-served',
    'upstream-non-2xx',
    'upstream-request-failed',
    'runtime-failed',
  ]),
  usage: SubmissionUsageSchema.nullable(),
  consent: CliResumeConsentSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
});
```

The three hashes originate in separate children and converge here:

- `bundleContentHash` — from `ReplayPreparationObservation.bundleContentHash`.
- `cliRequestHash` — from `ReplayProxyReceipt.cliRequestHash`.
- `outboundRequestHash` — from `ReplayProxyReceipt.outboundRequestHash`.

Keeping each hash in its originating child preserves boundary isolation; the
integration is the sole convergence point. The receipt also records converter
id/version, capability profile, source and replay CLI versions, outcome, and
timing from the proxy receipt and runtime observation.

The receipt NEVER includes: the real API key, the route token, full
request/response bodies, system prompts, tool schemas, the workspace path, or
any CLI-generated content. This inherits the proxy receipt's disclosure-safe
contract.

If the runtime fails but the proxy round-trip completed (the CLI sent the
request then exited non-zero), the receipt records `outcome: 'runtime-failed'`
alongside the real hashes and HTTP status. If no round-trip occurred, the
orchestration returns a failure result (not a receipt).

### 7. No-fallback guarantee is structural and runtime

**Structural:** `@mosga/replay-submit` has no dependency on
`@mosga/direct-submit`. A package-surface test asserts no import path reaches
`@mosga/direct-submit`, `submit`, `buildAnthropicRequest`,
`toAnthropicMessages`, or any reconstructed-request builder.

**Runtime:** `submitCliResume` returns `{ ok: false, error }` on every
failure condition (consent invalid, bundle invalid, CLI unsupported, probe
failed, workspace failed, route registration failed, process failed, timeout,
cancelled, upstream error). It never catches a failure and retries via a
different path.

**Daemon-level:** the daemon's submit route branches on
`consent.replayMode` at the top. A `cli-resume` request that fails returns an
HTTP error with a stable code; the handler never falls through to the
reconstructed-API `submit()` call. A dedicated test asserts this by injecting
a failing fake runtime and verifying the reconstructed path is not invoked.

### 8. Daemon submit route branches on replay mode

The existing `POST /api/reviews/:reviewId/submit` handler is extended:

```text
if consent.replayMode === 'cli-resume':
    validate cli-resume consent shape
    resolve the sealed bundle (from a replay-preparation step)
    resolve the upstream target + key (same provider/key store)
    call submitCliResume(...)
    return CliResumeReceipt or stable error
else (single-shot / turn-by-turn):
    existing submit() path (unchanged)
```

The branch happens before any side effect. The reconstructed-API path is
preserved verbatim — no code change to `submit()`, only the branch around it.

Error codes for cli-resume failures:
- `CONSENT_INVALID` (422) — consent validation failed.
- `BUNDLE_INVALID` (422) — bundle validation failed.
- `RUNTIME_UNSUPPORTED` (422) — CLI version/capability not supported.
- `RUNTIME_FAILED` (500) — workspace, process, or execution failure.
- `PROXY_FAILED` (500) — route registration or round-trip failure.
- `KEY_NOT_CONFIGURED` (400) — no upstream key for the target.
- `SUBMIT_FAILED` (500) — unexpected error, generic body.

Alternative considered: a separate `/api/reviews/:reviewId/replay/submit`
route. Rejected because the user chooses the mode in the same submit dialog;
having one endpoint with mode branching is simpler for the UI and keeps the
no-fallback boundary in one handler.

### 9. Replay preparation produces a sealed bundle from a review

A new daemon route `POST /api/reviews/:reviewId/replay/prepare` creates a
sealed `ReplayBundle` from the review's source session:

1. Retrieve the held review state (source adapter, session ref).
2. Call `adapter.captureNativeSession(ref)` → `NativeCaptureResult`. Fail
   closed on capture errors (malformed, partial, compressed input).
3. Discover instruction candidates (`CLAUDE.md` / `AGENTS.md`) from the
   project directory using the adapter's project ref. The caller supplies
   explicit candidates; the foundation performs no discovery.
4. Build the `TerminalManifestSeed` and `ReplayRuntimePolicy` from the
   capture's safe source summary and the fixed v1 policies.
5. Call `createReplayDraft(...)` → draft.
6. Call `scanReplayDraft(draft, ruleset)` → scan result + mapper.
7. Store the draft, scan result, and mapper in the review state (alongside
   the existing normalized review).
8. Return the replay scan report and a draft id.

After the user reviews replay findings and sets dispositions:

`POST /api/reviews/:reviewId/replay/seal` → calls
`applyReplayDispositions(draft, report, mapper, {...})` and
`sealReplayBundle(reviewedPayload)` → returns the sealed bundle (or a sealed
reference). The sealed bundle is held in the review state and consumed by the
submit route.

The replay finding disposition endpoints reuse the existing
`/api/reviews/:reviewId/findings/:findingId/disposition` pattern but operate
on the replay scan report. A replay gate (computed via `computeReplayGate`)
must be unlocked before sealing.

Alternative considered: skip the preparation route and assume the bundle is
created by a CLI tool. Rejected because the design requires a working
end-to-end path from the review UI, and the submit route cannot function
without a sealed bundle.

### 10. UI exposes mode selection and extended consent

The `SubmitPanel` component is extended:

- A mode selector defaults to `cli-resume`. The existing `single-shot` and
  `turn-by-turn` options are grouped under a "Compatibility: reconstructed
  API" label with a tooltip explaining they do not provide request
  authenticity.
- For `cli-resume`, the consent dialog adds a third checkbox:
  `runtimeContextAcknowledged` — "I understand the source CLI will add its own
  system prompt, tool definitions, and skill descriptions at runtime, and
  these are not rescanned."
- The estimate step for `cli-resume` shows the bundle's trajectory counts and
  the fixed one-request cost model, not the session-prefix token count.
- The receipt display for `cli-resume` shows all three hashes, the converter,
  and both CLI versions. The existing receipt display is preserved for compat
  mode.

The API client types are extended with `CliResumeReceipt` and
`CliResumeConsent`.

### 11. Surface unsupported-version failures clearly

When `runtime.prepare` returns `ok: false` with `cli-version-unsupported` or
`cli-capability-unsupported`, the orchestration maps it to a
`CliResumeSubmitFailure` with `code: 'runtime-unsupported'`, the `sourceCli`,
and the `replayCliVersion` (if the probe reached that far). The daemon surfaces
this as `RUNTIME_UNSUPPORTED` (422) with the CLI name and version so the user
can install or update the required CLI. The orchestration does NOT retry with a
different adapter, a different profile, or a fallback invocation.

### 12. Stable, disclosure-safe failure contract

```ts
export type CliResumeSubmitErrorCode =
  | 'consent-invalid'
  | 'bundle-invalid'
  | 'runtime-unsupported'
  | 'runtime-failed'
  | 'proxy-failed'
  | 'upstream-failed'
  | 'cancelled'
  | 'timed-out'
  | 'orchestration-internal-error';

export interface CliResumeSubmitFailure {
  readonly code: CliResumeSubmitErrorCode;
  readonly sourceCli: SourceCli | null;
  readonly replayCliVersion: string | null;
  readonly capabilityProfileId: string | null;
  readonly stage: 'consent' | 'bundle' | 'prepare' | 'render'
    | 'register' | 'execute' | 'receipt' | 'dispose';
  readonly runtimeCleanup: 'not-started' | 'complete' | 'failed';
  readonly proxyCleanup: 'not-started' | 'complete' | 'failed';
}
```

No public value includes the real API key, route token, full request/response
bodies, system prompts, tool schemas, workspace path, or CLI-generated content.
The failure carries only stable identifiers and cleanup state so the caller
(daemon/UI) can report what happened without leaking internals.

### 13. Test the boundary without real CLIs, providers, or keys

Focused tests live in `@mosga/replay-submit` and use:

- sealed fake `ReplayBundle` values produced by the runtime fixtures;
- a fake `ReplayRuntime` whose `prepare` returns a canned observation and
  whose `execute` returns a canned success/failure;
- a fake `ReplayProxy` whose `registerRoute` returns a canned binding and
  whose receipt resolves with a canned `ReplayProxyReceipt`;
- fake `ReplayUpstreamTarget` values with no real key;
- consent fixtures for every validation branch (missing ack, hash mismatch,
  target mismatch, policy mismatch).

Tests cover: orchestration order, terminal manifest determinism and content,
consent validation matrix, three-hash receipt assembly, no-fallback
guarantee (package-surface + runtime), unsupported-version surfacing, dispose
on every exit path, cancellation, timeout, partial-failure (runtime fails but
proxy receipt resolves), and disclosure safety (no key/token/body in receipt
or failure).

End-to-end daemon tests use an injectable fake runtime + fake proxy +
fake upstream transport to drive the full submit route from HTTP request to
receipt without launching a CLI or contacting a provider. Compatibility tests
verify the existing `single-shot` submit path is unchanged when the mode is
not `cli-resume`.

No test launches a real `claude` or `codex` binary, contacts a real provider,
uses a real API key, or binds a non-loopback address.

## Risks / Trade-offs

- **[The sealed bundle and the held review state can drift]** → Consent binds
  the validated bundle hash; the orchestration re-validates the bundle via
  `validateReplayBundle` and the runtime validates it again internally. A
  stale bundle whose content changed after sealing fails closed.
- **[The CLI exits non-zero after sending the request]** → The proxy receipt
  still resolves (the round-trip completed); the orchestration records
  `outcome: 'runtime-failed'` alongside the real hashes. The user sees both
  the failure and the audit trail.
- **[Preparation discovers no instruction files]** → The bundle records the
  omission explicitly; the terminal manifest discloses it. The CLI resumes
  without project instructions, which is a fidelity loss but not a failure.
- **[A future CLI profile is added after this child ships]** → The
  orchestration surfaces it automatically (it reads the runtime's
  `capabilityProfileId`); no integration code change is needed. The
  unsupported-version path remains the fail-closed default for unknown
  versions.
- **[The daemon holds both the replay stack and direct-submit]** → This is
  intentional: the daemon is the one fan-in point. The no-fallback guarantee
  is enforced inside `@mosga/replay-submit` (which cannot import
  direct-submit) and at the daemon handler level (explicit branch, no
  fallthrough).
- **[Replay preparation duplicates some review flow concerns]** → The
  preparation route uses the same compiled ruleset and the same pseudonym
  mapper discipline as the normalized review, but operates on native rows via
  the replay scan/apply APIs. This is necessary because cli-resume requires
  source-native format, not normalized messages.

## Migration Plan

1. Add `@mosga/contracts` schemas for `CliResumeConsent`, `CliResumeReceipt`,
   and the extended failure types. Existing schemas are unchanged.
2. Add `@mosga/replay-submit` with its public types, terminal-manifest
   renderer, consent validation, orchestration function, and receipt assembly.
   Place it after `@mosga/replay-proxy` in root build/typecheck order.
3. Add focused package tests (fakes only), then the package-surface
   no-fallback assertion.
4. Extend `@mosga/daemon` with the submit-route branch, replay-preparation
   routes, and the cli-resume error-code mapping.
5. Extend `@mosga/ui` with the mode selector, extended consent checkboxes,
   and receipt display.
6. Run repository-wide typecheck, test, and build gates.
7. Add end-to-end daemon tests and compatibility tests.
8. Update documentation (README, the office-hours design status, the change
   design's acceptance-criteria checklist).

Rollback: the new package and routes are additive. Removing them restores the
prior reconstructed-API-only behavior. No existing session, review, provider,
receipt, or direct-submit format is migrated or broken.

## Open Questions

- The exact instruction-candidate discovery heuristic (which directories to
  scan, how to order `CLAUDE.md` / `AGENTS.md` scope) must be fixed at
  implementation time against the CLI's documented discovery rules. Until
  verified, the preparation route fails closed rather than guessing.
- The replay-preparation route may need a separate review UI tab or a
  mode-aware review view; the exact UI integration point is an
  implementation-time decision guided by the existing review-view component
  structure.
- Whether the estimate route needs a cli-resume variant (the cost model is
  different: one request, bounded by the CLI's context management) or whether
  the bundle's trajectory counts are sufficient for the consent dialog. The
  initial implementation can show trajectory counts and the fixed one-request
  model without a separate estimate call.
