## Context

`@mosga/session-readers` ships one adapter (Claude Code) behind the `CliSourceAdapter` seam (`id`/`displayName`/`locateRoots`/`listProjects`/`listSessions`/`resolveTranscriptPath`/`parseTranscriptToMessages`). The registry (`registry.ts`) maps ids → adapters; the daemon `/api/sources*` routes and the UI Picker are fully dynamic (`listAdapters()` for the source list, `getAdapter(sourceId)` for dispatch, `annotateProject` keyed purely off `project.cwd`). So adding a CLI is registering one adapter — no consumer edits.

elftia holds a battle-tested codex rollout reader (MIT reuse authorized by the initiator, same authorization already exercised for the claude `JsonlParser`/`types` extraction):
- `codexAdapter.ts` — date-tree enumeration + bounded-prefix `session_meta`/title scan.
- `codexRolloutParser.ts` — maps codex `response_item` rollout lines to `ParsedAgentMessage[]`.
- `codexToolNormalize.ts` — `shell`→`Bash` / `update_plan`→`TodoWrite` name/arg reshape + `{output,metadata}` output-envelope unwrap.

Codex on-disk shape: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-ts>-<uuid>.jsonl[.zst]`, one JSON object per line `{ timestamp, type, payload }`. `session_meta` (line 1) carries `id`/`cwd`. `response_item` is the conversation SSOT; the parallel `event_msg` stream mirrors it for live UI and MUST be ignored to avoid doubling.

Constraint reminders: enumeration is pure-FS, never-throw, roots-as-arguments (temp-dir testable); the non-text-marker contract ("mark, not strip", no silent drop) applies; E: disk is tight (elftia is read-only reference); existing 219 tests must stay green.

## Goals / Non-Goals

**Goals:**
- A registered `codex` adapter enumerating codex rollouts by date tree, grouped into projects by `session_meta.cwd`, with an `(unknown)` project for cwd-less rollouts.
- A codex transcript parser producing `@mosga/contracts` `ParsedMessage[]`, honoring the non-text marker for non-`input_text`/`output_text` message parts.
- Zero consumer change: daemon/UI/whitelist pick codex up unchanged.
- Seam stays open for future CLIs (Cursor, …) with no speculative code.

**Non-Goals:**
- `.jsonl.zst` decompression (no zstd/wasm dependency this slice).
- elftia's dropped surface: `read` display-IR, `resolveTranscriptPathById`, `registryBackendId`, memory/subagent/continue. mosga's leaner interface excludes them.
- Any consumer, daemon, UI, or contract change. Cursor/other adapters.

## Decisions

### D1 — Adapt (not byte-verbatim wrap) the codex parser; stamp the non-text marker INLINE

The claude path reused `JsonlParser.ts` byte-verbatim and added markers in a thin external wrapper (`parseClaudeSession.ts`) that correlated raw entries to emitted messages **by `uuid`**. Codex rollout items have **no stable per-item id** — the elftia parser synthesizes a `randomUUID()` per emitted message and emits in file order — so an external re-scan cannot reliably correlate a raw non-text part back to its message. Therefore the codex parser is **adapted into mosga** (from elftia's `codexRolloutParser`, with types re-pointed at `@mosga/contracts`, mirroring how `JsonlParser`/`types` were extracted) and the `nonTextContent` marker is stamped **inline during the single pass**, where the part→message correlation is trivially available. This is a deliberate, documented divergence from the claude verbatim-wrapper pattern, justified by the format difference; the "mark, not strip" contract is upheld identically.

- Marker scope: only `message` content parts are scanned. For a role=user `message`, any content part whose `type` is not `input_text`; for role=assistant, any part whose `type` is not `output_text` → the part `type` string is added to that message's `nonTextContent.blockTypes`. `reasoning.summary` parts and tool outputs (stdout strings) are text channels and are not marked. Alternatives considered: (a) verbatim-wrap + positional re-scan — rejected as fragile (duplicates emit logic); (b) mark every non-recognized item type at the line level — rejected as over-broad (would flag internal item kinds that carry no user content).

### D2 — `.jsonl.zst` policy: recognize, skip at enumeration, parse to `[]` — no zstd dependency

elftia lazily decompresses `.zst` via `fzstd` at read time. mosga is an export pipeline with no decompressor and a deliberate no-new-dependency stance for this slice. Decision: the adapter **recognizes** `.jsonl.zst` (so the walk is complete) but does **not** enumerate it as a session, and the parser returns `[]` for a `.zst` path. Skipping an unreadable-format file at enumeration matches the existing degrade-cleanly discipline (the claude adapter already skips project dirs with no `.jsonl`) and, unlike listing-but-empty, never offers the user a session that would export to zero bytes. Alternatives: (a) list `.zst` with filename-uuid + empty parse — rejected: presents an un-exportable session, confusing UX; (b) add `fzstd` now — rejected: new dependency for a case with ~0 occurrences on the target machine. Later: add a zstd decoder to enumerate + parse `.zst`.

### D3 — Enumeration mirrors `codexAdapter.ts` discipline exactly

Bounded date-tree walk (`MAX_WALK_DEPTH = 8`), pure `fs.readdirSync`/`statSync` in try/catch that `continue`s on failure, one `scanCodexRollouts(roots)` feeding both `listProjects` (dedup by cwd) and `listSessions` (filter by project key). Bounded prefix read (128 KB / 60 lines) for `session_meta` + first non-scaffolding user `input_text` title, filename trailing-UUID as id fallback. `(unknown)` synthetic key for cwd-less rollouts (`cwd: null`, so `annotateProject` returns not-recommended with "no working directory to probe" — verified source-agnostic, no whitelist change). `resolveTranscriptPath` returns `ref.path`.

### D4 — File layout mirrors the claude split; keep utils under the ~300-line cap

- `src/adapter/codexAdapter.ts` — enumeration + `parseTranscriptToMessages` delegate (mirrors `claudeCodeAdapter.ts`).
- `src/parseCodexSession.ts` — public parse entry (mirrors `parseClaudeSession.ts`): read file, `.zst`→`[]`, split lines, call the line-mapper.
- `src/parsers/codexRollout.ts` — the `response_item`→`ParsedMessage[]` line-mapper with inline non-text marking.
- `src/parsers/codexToolNormalize.ts` — `shell`/`update_plan` normalize + output-envelope unwrap (adapted verbatim from elftia; pure, unit-tested directly).
- `registry.ts` registers `codexAdapter`; `index.ts` exports `codexAdapter` + `parseCodexSession` (+ `parseCodexSessionMeta` for tests, paralleling `extractClaudeTitle`).

### D5 — Update the one registry assertion this change legitimately breaks

`registry.fake-adapter.test.ts` asserts the default registry ids `toEqual(['claude-code'])`. Registering codex makes the true set `['claude-code', 'codex']`; the assertion is updated to match. This is the sole existing test the registration touches; it is a correctness update, not a regression waiver.

## Risks / Trade-offs

- **`.zst` rollouts silently absent** → Mitigation: documented limitation in the spec + adapter header; enumeration skip is consistent with degrade-cleanly, not a content truncation (nothing inside an exported session is dropped). Later ticket to add zstd.
- **Codex format drift (item types / envelope shape)** → Mitigation: parser skips unknown `response_item` kinds and unparseable lines, never throws; mirrors elftia's tolerant handling already field-tested.
- **Non-text marker under/over-reach** → Mitigation: marker scoped strictly to `message` part types (D1); covered by a dedicated image-part test and a pure-text negative test.
- **Adapted-not-verbatim parser diverges from a future elftia re-sync** → Mitigation: file header records provenance + the D1 rationale; the mapping table is small and stable (Responses-API item model).
- **`event_msg` accidentally consumed → doubled messages** → Mitigation: parser hard-gates on `type === 'response_item'`; a fixture that includes an `event_msg` mirror asserts no duplication.

## Open Questions

- None blocking. `.zst` support and additional CLIs (Cursor) are explicitly deferred (Later), not open questions for this slice.

## Review-round-1 amendment

The original Non-Goal "Any consumer, daemon, UI, or contract change" was crossed for **provenance correctness** (M1). With codex registered, a codex session flowed into `POST /api/reviews` and the daemon `buildEnvelope` hardcoded `meta.sourceCli: 'claude-code'`, mislabeling every codex transcript's provenance in the review/publish record. The boundary was crossed only as far as correctness demands:

- `packages/contracts/src/envelope.ts` — appended `'codex'` to `SOURCE_CLI_VALUES` (the exact additive/non-breaking widening D7 anticipated; the existing "extensible enum" scenario already foresaw this value, so no `session-contracts` spec delta is contradicted or needed).
- `packages/daemon/src/envelope.ts` — `buildEnvelope` now derives `sourceCli` from `ref.sourceId` via `SourceCliSchema.parse` (adapter source ids equal the enum values), failing closed on an unknown id in the codebase's idiomatic zod-throw style rather than mislabeling.
- A daemon `envelope.test.ts` proves a codex ref → `sourceCli: 'codex'` and claude-code still maps to `'claude-code'`.

No main-spec requirement pins `sourceCli` to claude-code (the `session-contracts` "extensible enum defaulting to claude-code" scenario only asserts claude-code is accepted and the enum is extendable — both remain true), so no delta was added.
