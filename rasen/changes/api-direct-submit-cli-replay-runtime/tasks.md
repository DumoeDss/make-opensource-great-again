## 1. Package and public contracts

- [x] 1.1 Scaffold `@mosga/replay-runtime` as an ESM/tsup workspace package depending only on `@mosga/contracts` and `@mosga/replay-bundle`, and place it after replay-bundle in root build/typecheck order.
- [x] 1.2 Define the closed `ReplayRuntimeErrorCode`, stage, cleanup-state, safe failure, preparation observation, execution result, and cleanup result types.
- [x] 1.3 Define `ReplaySkillRoot`, `ReplayRouteRequirement`, `ReplayRouteBinding`, prepare/execute inputs, `ReplayRuntime`, and opaque one-use `PreparedReplay` public interfaces.
- [x] 1.4 Add a package-surface test proving only the high-level runtime/types are exported and no sanitizer, source rereader, raw materializer, arbitrary command executor, prompt/body output, proxy, or direct-submit fallback surface is exposed.

## 2. Validation and prepared-handle boundary

- [x] 2.1 Implement validation-first preparation using `validateReplayBundle`, retain the content hash only after strict post-validation parsing, and introduce a non-exported brand required by all adapter/materialization internals.
- [x] 2.2 Validate fixed v1 runtime policies, source CLI/format identities, project/working-directory aliases, trusted binary overrides, limits, and skill-root descriptors before bundle-derived writes.
- [x] 2.3 Implement the `prepared -> running/consumed -> cleaning -> disposed` state machine with a safe immutable observation, at-most-one `execute`, and idempotent `dispose`.
- [x] 2.4 Add tests for intact preparation, every bundle integrity mutation failing before workspace creation, unsafe aliases/policies, caller-asserted payload rejection, one-use enforcement, and repeated disposal.

## 3. Capability probing and profile selection

- [x] 3.1 Define internal runtime-adapter, probe-command/evidence, capability-profile, storage-plan, control-file, launch-plan, and route-injection contracts plus the closed Claude/Codex registry.
- [x] 3.2 Implement trusted absolute binary resolution and fixed version/help probes with `shell: false`, minimal isolated probe environment, timeout, output caps, in-memory parsing, and no raw-output result/logging.
- [x] 3.3 Implement profile selection requiring one matching source/version predicate, source format, and every declared resume/stdin/isolation/routing capability; map missing, unknown, incompatible, and ambiguous evidence to stable fail-closed codes.
- [x] 3.4 Add fixture-matrix tests for binary absent, malformed/hanging/oversize probes, version-only false positives, missing capability markers, unknown newer versions, ambiguous profiles, and proof that no probe resumes a session or receives route/prompt data.

## 4. Claude Code runtime adapter

- [x] 4.1 Establish the initial supported Claude Code compatibility profile(s) from sanitized captured version/help fixtures, recording exact tested version predicates, session storage mapping, isolated home/config behavior, headless resume flags, stdin prompt behavior, non-interactive policy, telemetry/update suppressors, and Anthropic route variables.
- [x] 4.2 Implement the Claude storage mapper and static launch/environment planner for `claude-code-jsonl`, using the validated session alias and isolated cwd without reading a live Claude home or source project.
- [x] 4.3 Add fake-CLI Claude tests that require the exact canonical layout/argv/stdin/environment, reject every profile near miss, and prove resume failure launches no alternate invocation.

## 5. Codex runtime adapter

- [x] 5.1 Establish the initial supported Codex compatibility profile(s) from sanitized captured version/help fixtures, recording exact tested version predicates, rollout storage mapping, isolated `CODEX_HOME`, `exec resume` flags, stdin behavior, non-interactive policy, telemetry/update suppressors, and Responses provider-override behavior.
- [x] 5.2 Implement the Codex storage mapper and static launch/environment planner for `codex-jsonl`, including minimal provider config that references the route-token environment variable and never embeds a token/upstream key or relies on `OPENAI_BASE_URL` alone without proven profile support.
- [x] 5.3 Add fake-CLI Codex tests that require the exact canonical rollout/config/argv/stdin/environment, reject every profile near miss, and prove resume failure launches no alternate invocation.

## 6. Private workspace and exact bundle staging

- [x] 6.1 Implement random owner-private replay-root creation under a dedicated temp namespace, marker creation, resolved containment/no-follow path helpers, collision detection, and safe working/home/config/cache/temp directories.
- [x] 6.2 Materialize every native file exactly once through `serializeNativeJsonl` into the selected profile destination, with no adapter byte transformation and writes confined to the disposable copy.
- [x] 6.3 Materialize all and only sealed instruction entries through `serializeInstructionFile` at their exact `stagePath`, make them read-only, and reject missing, extra, overlapping, unsafe, or failed entries without instruction discovery.
- [x] 6.4 Generate only allowlisted profile control files from aliases/isolated paths/fixed values/environment-variable names, then verify a complete pre-launch inventory with no session/instruction/prompt/token body in control content.
- [x] 6.5 Add workspace tests for canonical byte equality, full native/instruction accounting, source session/project removal and immutability, containment and link attacks, partial-write cleanup, and CLI writes staying inside the root.

## 7. Detached read-only skill exposure

- [x] 7.1 Implement deterministic skill-root validation/ordering and bounded snapshot copying for regular files/directories with file-count, per-file, and total-byte limits.
- [x] 7.2 Reject symlinks, junctions/reparse points, special files, traversal, and merge collisions; map snapshots to each selected profile's native user/project skill discovery locations and remove write bits.
- [x] 7.3 Add tests for empty roots, multi-root precedence, source non-aliasing/immutability, limit failures, link/special-file escape refusal, read-only snapshot permissions, and description/body canaries absent from argv/stdin/environment/control files/results.

## 8. Route binding, minimal environment, and terminal input

- [x] 8.1 Implement non-secret route requirements from the selected profile plus sealed target and validate execution bindings for exact source/protocol/auth/target equality, explicit-port HTTP loopback URL, nonempty token, and CLI-facing model.
- [x] 8.2 Implement explicit platform/profile environment allowlists that redirect all CLI state/temp paths, add only required locale/platform/update/route variables, and never spread `process.env` or accept arbitrary caller environment fields.
- [x] 8.3 Validate nonempty bounded Unicode terminal input, reject NUL/unpaired-surrogate/oversize values, encode it once to UTF-8 stdin, and keep it out of argv, environment, files, hashes, results, and logs.
- [x] 8.4 Add tests for matching bindings, every remote/URL/protocol/source/target mismatch, parent secret-variable exclusion, no real-credential input surface, exact stdin delivery, and invalid terminal input preventing process launch.

## 9. Process supervision, cancellation, and cleanup

- [x] 9.1 Implement absolute-executable `shell: false` spawning with isolated cwd/environment, piped stdio, dedicated POSIX process groups, and the Windows process-tree termination strategy behind a testable platform host.
- [x] 9.2 Continuously drain and discard stdout/stderr with per-stream/combined byte limits, close stdin/listeners/timers/streams on every path, and map spawn, output overflow, and nonzero exit without exposing raw causes.
- [x] 9.3 Implement pre-abort handling plus a first-wins cancellation/deadline latch, graceful tree termination, bounded grace, forced tree termination, and wait-for-close behavior.
- [x] 9.4 Implement one idempotent finalizer covering prepare failure, dispose, success, spawn failure, nonzero exit, overflow, cancellation, and timeout; make cleanup failure override success with `cleanup-failed`.
- [x] 9.5 Implement marker- and age-scoped stale replay-root cleanup with verified dedicated-base containment and no link following.
- [x] 9.6 Add deterministic fake-process tests for normal exit, spawn error, prompt/token/body-echoing stderr, output overflow, pre-abort, cancel-vs-timeout races, graceful/forced descendant termination on POSIX/Windows hosts, every cleanup path, cleanup failure, and unrelated temp-directory preservation.

## 10. Facade integration and boundary verification

- [x] 10.1 Wire validation, probing, profile selection, workspace/instruction/skill staging, route/terminal validation, launch, result classification, and cleanup through `createReplayRuntime` without adding daemon/UI/direct-submit orchestration.
- [x] 10.2 Add end-to-end fake Claude and fake Codex prepared-replay tests proving safe observations, correct route requirements, one stdin prompt, one process launch, isolated writes, original-data immutability, and cleanup after both success and refusal.
- [x] 10.3 Add exhaustive safe-result canary tests for every documented error code/stage and source scan tests proving the package cannot import sanitizer, provider transport/key storage, proxy/network servers, or reconstructed submit code.
- [x] 10.4 Document the package's public prepare/render-register/execute/dispose handoff for the later proxy and integration children, including the explicit no-fallback and no-raw-diagnostic guarantees.

## 11. Compatibility and repository verification

- [x] 11.1 Run the replay-runtime focused tests and confirm they never invoke installed Claude/Codex binaries, real user homes/sessions/projects/instructions/skills, live routes, or credentials.
- [x] 11.2 Run replay-bundle, contracts, session-readers, sanitizer, direct-submit, daemon, publisher, and existing process-related focused suites to confirm the additive package changes no current behavior.
- [x] 11.3 Run repository-wide typecheck, test, and build commands and resolve package export/build-order/platform regressions.
- [x] 11.4 Record only final implementation-discovered runtime/profile interface constraints needed by the proxy and integration children in the parent planning context.
