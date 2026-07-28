## 1. Replay contracts

- [x] 1.1 Add strict JSON-value, native JSONL row/file/artifact, native-capture result/error, and safe source-summary schemas/types to `@mosga/contracts`.
- [x] 1.2 Add instruction candidate/snapshot, omission, runtime policy, delivery target, trajectory, and terminal-manifest-seed schemas with v1 literals and strict unknown-key rejection.
- [x] 1.3 Add replay finding/review evidence, integrity-entry, ReplayBundle draft/payload/integrity/bundle schemas and export all new contract types.
- [x] 1.4 Add contract tests for complete v1 parsing, unsupported versions/policies, forbidden extra secret fields, JSON-safe values, and source-vs-target model separation.
- [x] 1.5 Document the ReplayBundle v1 fields and hashing boundary and add a schema/doc anti-drift test without changing the existing `SanitizedSession` contract.

## 2. Strict native session capture

- [x] 2.1 Implement a shared read-only strict JSONL capture helper that retains every nonblank object row/ordinal and returns stable no-partial failure results for unreadable, empty, malformed, non-object, or unsupported input.
- [x] 2.2 Extend `CliSourceAdapter` and registry fake adapters with `captureNativeSession(ref)` while leaving normalized parse/enumeration method behavior unchanged.
- [x] 2.3 Implement Claude Code native capture and deterministic safe source/trajectory extraction without projecting away meta, tool-result, unknown, or duplicate logical rows.
- [x] 2.4 Implement Codex native capture and deterministic safe source/trajectory extraction while retaining `session_meta`, `turn_context`, `response_item`, `event_msg`, compacted, and unknown rows.
- [x] 2.5 Return explicit `unsupported-compression` for Codex `.jsonl.zst` native capture and ensure failures contain neither raw content nor original absolute paths.
- [x] 2.6 Add fake-fixture tests for Claude/Codex row order, unknown fields, reference values, multiple model timelines, read-only behavior, malformed late-row refusal, and compressed-input refusal.

## 3. Replay scanning

- [x] 3.1 Add versioned replay finding-location, opaque-item, report, gate, result, and error schemas/types without changing existing `SanitizationReport` exports.
- [x] 3.2 Refactor shared detector execution behind internal scan-unit primitives and prove existing `scanSession` findings/ids/gates remain unchanged.
- [x] 3.3 Implement deterministic recursive JSON traversal with RFC 6901 pointers for every native string leaf plus instruction-content and fixed-metadata scan units.
- [x] 3.4 Implement stable replay finding ids/resolution and one replay-wide `PseudonymMapper` across native, instruction, and metadata artifacts.
- [x] 3.5 Detect source-recognized opaque/non-text blocks as pending replay review items and include them in the pure replay gate without auto-removal.
- [x] 3.6 Add scan tests for secrets in unknown/nested/JSON-encoded fields, instruction coverage, cross-artifact pseudonyms, exact pointer/span resolution, stable re-scan ids, redacted previews, and oversize guards.

## 4. Replay disposition application

- [x] 4.1 Implement immutable replay draft cloning, exact artifact-location reads/writes, offset-safe span editing, and explicit errors for stale/missing/out-of-range locations.
- [x] 4.2 Apply native/instruction/metadata findings without changing row/file order, unrelated unknown fields, scalar types, or structural reference values.
- [x] 4.3 Implement explicit opaque-item keep/remove/replace handling with reviewed omission records and no automatic stripping.
- [x] 4.4 Enforce replay report/draft/ruleset identity, unlocked-gate eligibility, schema-valid reviewed output, and post-apply blocking-canary verification.
- [x] 4.5 Stamp sealable review evidence with report/ruleset/decision versions, redacted dispositions, approval time, and `humanReviewPassed: true`.
- [x] 4.6 Add fake-fixture tests for cross-artifact batch replacement, stale report refusal, Claude/Codex structure preservation, opaque gating, input immutability, and absence of replaced/deleted canaries from canonical content.

## 5. ReplayBundle construction and integrity

- [x] 5.1 Scaffold `@mosga/replay-bundle`, add workspace build/typecheck ordering, and expose only draft construction, canonical serialization, sealing, and validation entry points.
- [x] 5.2 Implement instruction candidate conversion with UTF-8/LF normalization, deterministic ordering, duplicate rejection, source-path elision, and strict POSIX stage-path/basename validation.
- [x] 5.3 Implement ReplayBundle draft construction from captured native data plus explicitly supplied instructions, target/policies, terminal seed, and omissions without project discovery or side effects.
- [x] 5.4 Implement `mosga-replay-canonical-json-v1` and canonical LF-terminated native JSONL/instruction byte serializers with rejection of non-JSON values.
- [x] 5.5 Implement sorted per-entry SHA-256 manifests and pure domain-separated sealing over `{ domain, payload, entries }`, returning `sha256:`-prefixed hashes distinct from legacy session hashes.
- [x] 5.6 Implement fail-closed bundle validation that rederives entries/root and reports stable errors for mutation, missing/extra entries, unsafe paths, malformed digests, or unsupported versions.
- [x] 5.7 Add deterministic seal tests, row-order/policy sensitivity tests, instruction/native mutation tests, self-contained validation tests, and explicit rejection of legacy unprefixed hashes.

## 6. Compatibility and verification

- [x] 6.1 Verify the foundation code never launches a CLI, reads skill bodies/provider keys, writes the source session/project, sends network requests, or integrates a reconstructed fallback.
- [x] 6.2 Run contracts, session-readers, sanitizer, replay-bundle, daemon, export, and direct-submit focused tests to confirm all existing normalized flows remain compatible.
- [x] 6.3 Run repository-wide typecheck, test, and build commands and resolve any schema/export/build-order regressions.
- [x] 6.4 Record the final exported foundation interfaces and any implementation-discovered constraints for the runtime, proxy, and integration children in the parent planning context.
