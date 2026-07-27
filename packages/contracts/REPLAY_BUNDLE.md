# ReplayBundle v1

`ReplayBundle` is the reviewed, source-native foundation artifact used by the
future CLI replay runtime. It is deliberately separate from `SanitizedSession`;
the latter remains the normalized export and compatibility-submit contract.
ReplayBundle v1 uses the exact schema version `1.0.0`.

The contract is a logical in-memory artifact. It contains no upstream API key,
route token, original absolute path, complete skill body, CLI-generated system
prompt, tool schema, replay CLI version, request hash, receipt, or consent
instance.

## ReplayBundle fields

| Field | Type | Notes |
| --- | --- | --- |
| `payload` | `ReplayBundlePayload` | Complete reviewed fixed input. |
| `integrity` | `ReplayBundleIntegrity` | Derived entry manifest and domain-separated root. |

## ReplayBundlePayload fields

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `"1.0.0"` | ReplayBundle payload version. |
| `draftId` | `string` | Stable identity bound to scan and review evidence. |
| `source` | `SafeSourceSummary` | Safe source CLI/model summary; excludes workspace and repository identity. |
| `nativeSession` | `NativeSessionArtifact` | Ordered logical JSONL files and complete object rows. |
| `instructionSnapshot` | `InstructionSnapshot` | Sanitized LF-normalized instruction files at aliased POSIX stage paths. |
| `terminalManifestSeed` | `TerminalManifestSeed` | Reviewed fixed fields used later to render the sole terminal MOSGA turn. |
| `runtimePolicy` | `ReplayRuntimePolicy` | Fixed `cli-resume`, instruction, skill, rescan, alias, and one-request policy. |
| `delivery` | `ReplayDeliveryTarget` | Target provider and target model, distinct from source models. |
| `omissions` | `ReplayOmission[]` | Known excluded instruction, source-context, and opaque items. |
| `review` | `ReplayReviewEvidence` | Redacted decisions and a successful human-review assertion. |

## Native session fields

`NativeSessionArtifact` stores `schemaVersion`, `sourceCli`, `sourceFormat`,
`sessionIdAlias`, and ordered `files`. Each `NativeJsonlFile` stores an `id`,
`role`, aliased `logicalPath`, and ordered `rows`. Each row stores its
zero-based `ordinal` and complete JSON-object `value`. JSON arrays retain order;
object member order, source whitespace, source line endings, and blank lines are
not preservation inputs.

## Instruction fields

`InstructionSnapshot` stores `schemaVersion` and sorted `files`. Each file stores
`id`, `kind` (`claude-md` or `agents-md`), safe relative `stagePath`,
nonnegative outer-to-inner `effectiveOrder`, and UTF-8/LF `content`.
`InstructionCandidate.sourcePath` is input-only and is never copied into a draft.

## Source, policy, and terminal-seed fields

`SafeSourceSummary` stores `schemaVersion`, `sourceCli`, `sourceFormat`,
`sessionIdAlias`, nullable `recordedCliVersion`, nullable `modelProvider`,
`sourceModels`, `modelTimeline`, nullable `contextWindow`, `sessionMode`, and
`entrypoint`. A timeline entry stores `assistantTurnIndex`, `model`, and nullable
`effort`.

`ReplayTrajectory` stores `schemaVersion`, `totalRows`, `userTurns`,
`assistantTurns`, `toolCalls`, `toolResults`, and `compactedEvents`.
`ReplayDeliveryTarget` stores `schemaVersion`, `targetProviderId`, and
`targetModel`.

`ReplayRuntimePolicy` stores `schemaVersion`, `replayMode`,
`instructionPolicy`, `skillPolicy`, `proxyRescan`, `maxInferenceRequests`,
`projectAlias`, and `workingDirectoryAlias`. V1 fixes these policies to
`cli-resume`, `sanitized-snapshot`, `cli-discovery-read-only`, `false`, and `1`.

`TerminalManifestSeed` stores `schemaVersion`, `kind`, `purpose`, `source`,
`trajectory`, `sanitization`, `omissionPolicy`, the four fixed replay policies,
and `delivery`. Sanitization provenance stores `rulesetVersion`,
`reportVersion`, and `sanitizerPackageVersion`.

## Review fields

Replay finding locations are discriminated as `native`, `instruction`, or
`metadata` and carry exact character spans. Native locations additionally carry
`fileId`, `rowOrdinal`, and an RFC 6901 `jsonPointer`; instruction locations
carry `instructionId`; metadata locations carry a stable `fieldPath`.

`ReplayReviewEvidence` stores `schemaVersion`, `draftId`, `rulesetVersion`,
`reportVersion`, `decisionVersion`, `reviewedDraftHash`, redacted `findings`,
reviewed `opaqueItems`, `approvedAt`, and literal `humanReviewPassed: true`.
`reviewedDraftHash` is a `sha256:<lowercase-hex>` digest of the exact complete
sanitized draft that passed post-apply verification. It never stores the full
raw secret matched by a detector.

## ReplayBundleIntegrity fields

| Field | Type | Notes |
| --- | --- | --- |
| `algorithm` | `"sha256"` | Hash algorithm. |
| `canonicalization` | `"mosga-replay-canonical-json-v1"` | Canonical JSON/entry serializer identifier. |
| `entries` | `ReplayIntegrityEntry[]` | Complete path-sorted content manifest. |
| `contentHash` | `sha256:<lowercase-hex>` | Domain-separated bundle root. |

Each integrity entry stores `path`, `mediaType`, `byteLength`, and a
`sha256:<lowercase-hex>` `digest`.

## Hashing boundary

Review provenance uses the canonical UTF-8 encoding of
`{"domain":"mosga-replay-reviewed-draft:v1","draft":<complete draft>}`.
The shared draft projection removes only `review` from a payload, then
strict-schema-validates every remaining `ReplayBundleDraft` field. Object keys
are sorted and every array order is preserved. Apply produces this digest only
after successful post-apply verification; sealing and validation reconstruct
the same projection and reject a stale binding as `review-content-mismatch`.

Sealing first canonicalizes every native JSONL file (one canonical JSON object
and one LF per row) and every instruction file (UTF-8 with normalized LF). It
then creates the complete path-sorted `entries` manifest.

The root preimage is the canonical UTF-8 encoding of:

```json
{"domain":"mosga-replay-bundle:v1","payload":"<complete reviewed payload>","entries":"<complete derived manifest>"}
```

The quoted placeholders above are explanatory only; the actual preimage
contains the payload object and entries array. `integrity.contentHash` is outside
the preimage, so the seal is self-reference-free. Both entry digests and the root
use the mandatory `sha256:` prefix. The legacy unprefixed
`computeContentHash(SanitizedSession)` digest is a separate contract and is never
accepted as a ReplayBundle digest.
