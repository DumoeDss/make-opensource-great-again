## Context

The office-hours design establishes request authenticity as the product goal: a source Claude Code or Codex CLI must resume a sanitized native session and assemble the eventual request itself. The current repository cannot supply that input. `@mosga/session-readers` projects both CLIs into `ParsedMessage[]`; the Codex projection explicitly skips `session_meta` and `turn_context`; `@mosga/sanitizer` only scans and edits the known `SanitizedSession` shape; and `@mosga/direct-submit` hashes that normalized envelope before reconstructing a provider request.

This change is the first, foundation slice of the serial `bundle -> runtime -> proxy -> integration` plan. It must produce a fixed, reviewed input that later children can validate without rereading the original session or project. It must not launch a CLI, choose CLI flags, expose skills, register proxy routes, hold provider credentials, or change the current submit path.

The design source is `rasen/office-hours/api-direct-submit-cli-replay-design.md`, with the investigation in `rasen/office-hours/api-direct-submit-session-context.md`. Both distinguish fixed reviewed inputs from CLI-generated runtime context: native session bytes, instruction snapshots, terminal-manifest seed data, target, and policy can be sealed; a future CLI's generated system prompt and tool schema cannot.

## Goals / Non-Goals

**Goals:**

- Define a versioned logical `ReplayBundle` with schemas shared across later children.
- Capture valid Claude Code and Codex JSONL as source-native JSON structure without dropping unknown rows or fields.
- Sanitize every source-derived string in native rows, instruction snapshots, and fixed manifest metadata under one review gate and one pseudonym scope.
- Represent reviewed `CLAUDE.md` / `AGENTS.md` files at safe aliased staging paths while never storing their original absolute paths.
- Represent the fixed seed from which the later integration child can generate the one terminal MOSGA user turn.
- Seal and validate the full reviewed payload deterministically, including target and runtime policy, with explicit per-entry digests.
- Preserve all existing normalized reader, sanitizer, export, review, and reconstructed-submit APIs.

**Non-Goals:**

- Discovering the exact effective instruction closure for every CLI version; this change accepts explicitly discovered instruction candidates and validates their representation.
- Materializing a temporary CLI home/workspace or choosing Claude/Codex resume commands.
- Exposing skill roots or serializing skill descriptions/bodies.
- Creating a proxy, route token, converter, request hash, outbound hash, receipt, or credential flow.
- Changing consent orchestration or replacing the current `SanitizedSession` content hash.
- Defining a physical archive format. The contract is a logical in-memory bundle that a later runtime may materialize as a directory or content-addressed workspace.

## Decisions

### 1. Keep ReplayBundle separate from SanitizedSession

`SanitizedSession` remains the normalized UI/export and compatibility-submit artifact. A new `ReplayBundleSchema` is added to `@mosga/contracts`, while pure construction, canonical serialization, sealing, and validation live in a focused `@mosga/replay-bundle` package.

The logical shape is:

```text
ReplayBundle
├─ payload
│  ├─ schemaVersion: "1.0.0"
│  ├─ source
│  ├─ nativeSession
│  ├─ instructionSnapshot
│  ├─ terminalManifestSeed
│  ├─ runtimePolicy
│  ├─ delivery
│  ├─ omissions
│  └─ review
└─ integrity
   ├─ algorithm: "sha256"
   ├─ canonicalization: "mosga-replay-canonical-json-v1"
   ├─ entries[]
   └─ contentHash: "sha256:<lowercase-hex>"
```

The payload is JSON-safe and contains no raw filesystem path, API key, route token, full skill body, generated system prompt, or tool schema. `source.sessionId` is an alias or sanitized value, never an unchecked native identifier.

Alternative considered: widen `SanitizedSession` until it can resume a CLI. Rejected because its normalized messages have already lost unknown source structure and because mixing public-export data with private replay material would make both contracts harder to reason about.

### 2. Capture native JSONL as ordered JSON values, not raw bytes or ParsedMessage

Each supported adapter gains a strict native-capture method returning a discriminated success/failure result. A successful artifact records the source format and an ordered set of logical files; each JSONL file contains ordered `{ ordinal, value }` rows where `value` is the complete parsed JSON object. Unknown row types, unknown object members, array order, scalar types, session/turn/parent/tool-call identifiers, and duplicate logical rows are retained.

Whitespace, object-key order, and original line endings are not authenticity inputs. Runtime materialization will use the canonical JSONL serializer supplied by `@mosga/replay-bundle`: one canonical JSON object plus `LF` per row. The semantic JSON structure and row order are the preservation boundary.

Native capture is intentionally stricter than browse/preview parsing:

- every nonblank line must parse as a JSON object;
- missing, unreadable, empty, malformed, non-JSON-object, or unsupported compressed input returns a stable failure code;
- no line is skipped and no partial artifact is returned;
- source files are read only.

Claude and Codex both support uncompressed JSONL in v1. Codex `.jsonl.zst` remains unsupported and fails explicitly instead of appearing as an empty replay.

Alternative considered: copy the original bytes and apply regex replacements. Rejected because byte offsets are fragile, nested JSON strings cannot be edited safely, and deterministic cross-platform hashing would inherit irrelevant whitespace and newline differences.

### 3. Extract source context without removing it from the native artifact

Capture derives a safe source summary from the same ordered rows: source CLI/format, recorded CLI version when present, model provider, distinct source models, an assistant-turn model/effort timeline when derivable, context window, stable session mode/entrypoint enums, and trajectory counts. Derivation never deletes `session_meta`, `turn_context`, or equivalent native rows.

High-risk identity fields such as cwd, workspace roots, repository URL/branch/commit, and title are not copied into the summary. If they are required inside the native artifact for resume, they remain at their original structural location and go through replay sanitization. Missing or deliberately excluded source context is listed in `omissions`; absence is never represented as completeness.

Alternative considered: reread raw metadata during submit. Rejected because those bytes would not have been reviewed or covered by the bundle hash and may have changed since review.

### 4. Use one replay-wide sanitizer report and coordinate space

`@mosga/sanitizer` retains its current `SanitizationReport` APIs and adds replay-specific scan/apply types. A replay scan traverses:

- every string leaf at every JSON Pointer in every native row;
- every instruction file's text;
- every source-derived string in source context, terminal-manifest seed, omissions, delivery selection, and aliased placement metadata.

Tool-controlled schema literals, enums, booleans, numbers, and null values are validated but do not need text scanning. Findings use an artifact location:

```text
native:      file id + row ordinal + RFC 6901 JSON Pointer + span
instruction:file id + span
metadata:   stable payload field path + span
```

Finding IDs are derived from the stable location and rule id. The same `CompiledRuleset` behavior, redacted previews, L1/L2 blocking semantics, L3 normalization behavior, size/time guards, and one `PseudonymMapper` instance are reused across the whole draft. Thus the same original path or email receives the same placeholder whether it appears in a native row or an instruction file.

Known non-text or opaque payloads are surfaced as replay review items and keep the gate locked until explicitly dispositioned. Apply never silently removes them.

Alternative considered: stringify the whole bundle and run the outbound backstop. Rejected because a flat scan cannot give stable review locations or safely apply a replacement back into nested JSON.

### 5. Apply only reviewed spans and preserve surrounding structure

Replay apply clones the draft and applies `replace`, `delete`, or `allow` to the exact resolved string leaf. Multiple edits in one string use the existing outer-span-wins and descending-offset rules. Editing a parsed JSON string value needs no whole-object reparse, so surrounding keys, values, row order, and references are retained. `delete` deletes only the matched span, not its containing row, field, block, or instruction file.

After apply, every finding location is resolved again against the original draft before editing. A missing location, changed source value, invalid disposition, or locked gate is a hard error; it cannot produce a sealable payload. A successful result includes an approved review record with ruleset/report/decision versions, redacted findings and dispositions, an approval timestamp, and `humanReviewPassed: true`.

Alternative considered: reuse `applyDispositions(SanitizedSession, ...)` through a temporary normalized envelope. Rejected because it would recreate the structure-loss problem this change exists to solve.

### 6. Treat instruction closure discovery and snapshot representation as separate concerns

The foundation accepts `InstructionCandidate[]` from a caller that has already determined the effective closure. Each candidate provides private source bytes plus public, aliased placement metadata. The source absolute path is input-only and never enters the draft.

The stored snapshot file contains:

- a stable file id;
- kind `claude-md` or `agents-md`;
- a POSIX `stagePath` relative to the future replay root;
- a nonnegative `effectiveOrder` from outer to inner scope;
- UTF-8 text normalized to `LF`;
- sanitized content.

`stagePath` rejects absolute paths, drive/UNC prefixes, empty segments, `.`/`..` traversal, backslashes, NUL, and basenames other than `CLAUDE.md` or `AGENTS.md`. Files are sorted by `(effectiveOrder, stagePath)`, duplicate paths are rejected, and explicit omissions record any effective file the caller did not include. The runtime child must materialize only these validated paths and must not rediscover or read the original project.

Alternative considered: include the complete project tree. Rejected because it expands privacy exposure and violates the isolated replay design.

### 7. Store a fixed terminal-manifest seed, not the final runtime message

`terminalManifestSeed` contains only reviewed deterministic fields: purpose/kind/schema, source summary, trajectory statistics, sanitization/review provenance, omission policy, `cli-resume` mode, instruction policy, skill policy, `proxyRescan: false`, `maxInferenceRequests: 1`, and delivery target.

It deliberately excludes the replay CLI version, actual request hashes, receipt timestamps, route data, and the consent confirmation instance. Those values do not exist when the fixed bundle is reviewed. The later integration child must generate the sole terminal user message from:

1. this validated seed;
2. the validated bundle hash;
3. separately validated consent bound to the same target/policies/hash; and
4. runtime-observed replay CLI version.

This avoids a circular hash while ensuring every fixed terminal field is reviewed and sealed. No later child may reread the source session to enrich the manifest.

Alternative considered: hash the final terminal text. Rejected because it contains post-seal consent/runtime observations and would make `contentHash` self-referential.

### 8. Make the integrity seal deterministic and self-reference-free

`@mosga/replay-bundle` implements `mosga-replay-canonical-json-v1`: recursively sort object keys by code-point order, preserve array order, serialize JSON primitives without whitespace, encode UTF-8, and reject `undefined`, non-finite numbers, or non-JSON values.

Sealing proceeds in this fixed order:

1. Validate the reviewed payload schema and unlocked review record.
2. Canonically serialize every native JSONL file and UTF-8 instruction file.
3. Derive a sorted `entries[]` manifest with logical path, media type, byte length, and `sha256:<hex>` digest for every content entry.
4. Canonicalize `{ domain: "mosga-replay-bundle:v1", payload, entries }`.
5. SHA-256 the resulting bytes and store the prefixed digest as `integrity.contentHash`.

The root therefore covers the complete payload and the derived manifest, while the `contentHash` field itself is outside the preimage. `sealReplayBundle` is pure: the same payload produces identical entry digests and root hash. `validateReplayBundle` schema-validates, re-derives entries, recomputes the root, and returns a validated payload only on exact equality; mutation, missing/extra entry, unsafe path, unsupported version, or hash mismatch fails closed.

The legacy `computeContentHash(SanitizedSession)` remains unchanged. Its unprefixed digest is a different contract and must never be accepted as a ReplayBundle hash.

Alternative considered: reuse the sanitizer's pretty `canonicalJson`. Rejected because it was designed for stable tool-input spans, not as a versioned cross-artifact integrity protocol.

### 9. Expose narrow handoff interfaces to later children

The foundation exports:

```text
session-readers:
  adapter.captureNativeSession(ref) -> NativeCaptureResult

sanitizer:
  scanReplayDraft(draft, ruleset) -> ReplayScanResult
  applyReplayDispositions(draft, report, mapper) -> ReplayApplyResult

replay-bundle:
  createReplayDraft(input) -> ReplayBundleDraft
  serializeNativeJsonl(file) -> Uint8Array
  sealReplayBundle(reviewedPayload) -> ReplayBundle
  validateReplayBundle(bundle) -> ReplayBundlePayload
```

The runtime child consumes only `validateReplayBundle` plus the validated payload/serializers. It does not know sanitizer internals. The proxy child has no bundle mutation API. The integration child supplies instruction candidates, target/policies, consent, and final terminal rendering.

## Risks / Trade-offs

- **[CLI accepts semantically identical JSONL but depends on undocumented byte/layout details]** → Native rows retain all JSON semantics; exact storage layout is deferred to version-tested runtime adapters, and unsupported formats fail closed.
- **[Generic traversal misses content encoded inside a string]** → The containing string leaf is still scanned as text, including JSON-encoded arguments; focused nested-string canaries verify replacement.
- **[Sanitizing an identifier breaks a reference]** → One replay-wide mapper keeps equal values equal, structure/reference tests cover session/parent/tool-call links, and incompatible source-specific changes fail validation/runtime rather than falling back.
- **[Large native files increase memory and scan cost]** → Reuse bounded scan guards; any unscanned tail becomes a blocking review item. The v1 logical in-memory model matches the repository's current whole-session workflow.
- **[Instruction discovery is incomplete]** → The snapshot records only caller-supplied effective files, requires explicit omissions, and never claims completeness when a candidate is excluded.
- **[Review timestamps make otherwise equal reviews hash differently]** → This is intentional because approval evidence is part of the sealed payload; determinism means identical payload bytes yield the same seal.
- **[New schemas create two content-hash concepts]** → Replay hashes are always `sha256:`-prefixed and domain-separated; legacy hashes remain unprefixed and are explicitly rejected by ReplayBundle validation.
- **[Later children bypass validation or enrich from raw data]** → The runtime handoff is only a validated payload; the parent planning context records the no-reread/no-mutation interface decision.

## Migration Plan

1. Add ReplayBundle/native/instruction/source/review/integrity schemas and anti-drift tests to `@mosga/contracts`.
2. Add strict native capture to both registered session adapters without changing normalized parse outputs.
3. Add replay scan/apply/report APIs to `@mosga/sanitizer` while keeping current session APIs and tests green.
4. Add `@mosga/replay-bundle`, root build/typecheck wiring, deterministic serializers, seal/validate functions, and fake-fixture tests.
5. Leave all new APIs unused by production orchestration in this change. Later serial children adopt them explicitly.

Rollback is additive: remove the unused package/APIs and build wiring. No persisted current-format data or existing submit behavior is migrated by this foundation slice.

## Open Questions

- Exact Claude Code and Codex storage placement rules remain runtime-adapter spikes; the bundle provides format, session alias, logical file roles, and canonical bytes rather than hard-coding CLI home paths.
- Exact instruction discovery rules, including optional user-level files, remain integration/runtime policy work; the safe snapshot representation and explicit omission mechanism are fixed here.
- Compressed Codex rollout support and a physical archive/content-addressed format may be added under later schema versions. Version 1 rejects compressed input and defines only the logical bundle.
