## 1. Codex tool normalization (pure helpers)

- [x] 1.1 Add `packages/session-readers/src/parsers/codexToolNormalize.ts` adapted from elftia's `codexToolNormalize.ts` (MIT reuse, provenance header): `normalizeCodexTool(name, input)` (`shell`/`shell_command`→`Bash` with wrapper-stripped command, `update_plan`→`TodoWrite`, others verbatim) and `unwrapCodexOutput(raw)` (`{output, metadata}` envelope → inner stdout + nonzero `exit_code`→`isError`). Keep pure, never-throw, no byte loss.
- [x] 1.2 Keep the file under the ~300-line util cap; export `normalizeCodexTool`/`unwrapCodexOutput` for direct unit testing.

## 2. Codex rollout line-mapper (with inline non-text marking)

- [x] 2.1 Add `packages/session-readers/src/parsers/codexRollout.ts` adapted from elftia's `codexRolloutParser.ts`, re-pointing types to `@mosga/contracts` (`Role`, `ToolCall`, `ParsedMessage`); provenance + D1 rationale header.
- [x] 2.2 Map `response_item` lines only (ignore `event_msg`/`turn_context`/`session_meta`): `message` role=user `input_text`→user message (skip `<environment_context>`/`<user_instructions>` scaffolding), role=assistant `output_text`→assistant message, `reasoning.summary[].summary_text`→assistant message with `thinking` + empty content, `function_call`/`custom_tool_call`→`ToolCall` on a fresh assistant message keyed by `call_id`, `function_call_output`/`custom_tool_call_output`→merged onto owning call by `call_id`. Emit in file order; synthesize `sdkUuid`, `parentUuid: null`; skip unparseable lines (never throw).
- [x] 2.3 Handle `compacted` per elftia's lower-risk fallback (surface summary as a normal assistant message; no compaction cut).
- [x] 2.4 Stamp the non-text marker INLINE: for a `message` turn, any content part whose `type` is not `input_text` (user) / `output_text` (assistant) adds that `type` to the emitted message's `nonTextContent.blockTypes`; pure-text turns get no marker. Never drop the part silently.

## 3. Codex parse entry

- [x] 3.1 Add `packages/session-readers/src/parseCodexSession.ts` (mirrors `parseClaudeSession.ts`): read the rollout file, return `[]` for a missing/unreadable file OR a `.jsonl.zst` path (no decompression), else split lines and call the line-mapper. Never throws.

## 4. Codex source adapter

- [x] 4.1 Add `packages/session-readers/src/adapter/codexAdapter.ts` (mirrors `claudeCodeAdapter.ts` + elftia `codexAdapter.ts`): `id: 'codex'`, `displayName: 'Codex'`, `locateRoots(home)` → `[<home>/.codex/sessions]`.
- [x] 4.2 Implement a bounded (`MAX_WALK_DEPTH = 8`), pure-FS, never-throw date-tree walk recognizing `rollout-*-<uuid>.jsonl[.zst]`; one `scanCodexRollouts(roots)` feeding both list methods. `.jsonl.zst` recognized but NOT enumerated as a session (D2).
- [x] 4.3 Bounded prefix read (≤128 KB / 60 lines) → `session_meta` `id`/`cwd` + first non-scaffolding user `input_text` title; trailing filename UUID as id fallback. Export a pure `parseCodexSessionMeta(firstLines)` for tests (parallels `extractClaudeTitle`).
- [x] 4.4 `listProjects` dedups by `session_meta.cwd` (label = basename); cwd-less rollouts group under a synthetic `(unknown)` project with `cwd: null`. `listSessions` filters the scan by project key, fills `id`/`path`/`title`/`cwd`/`updatedAt` (mtime)/`sizeBytes`. `resolveTranscriptPath` returns `ref.path`; `parseTranscriptToMessages` delegates to `parseCodexSession`.

## 5. Registration & exports

- [x] 5.1 `registry.ts`: import and `registerAdapter(codexAdapter)` after the claude registration.
- [x] 5.2 `index.ts`: export `codexAdapter`, `parseCodexSession`, and `parseCodexSessionMeta`.
- [x] 5.3 Update `__tests__/registry.fake-adapter.test.ts` default-set assertion from `['claude-code']` to `['claude-code', 'codex']` (D5).

## 6. Tests (hand-crafted temp-dir fixtures only)

- [x] 6.1 Add `__tests__/codex-adapter.test.ts`: temp `~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<uuid>.jsonl` fixture → assert `id`/`displayName`/`locateRoots`; `listProjects` groups by cwd (label = basename); `listSessions` returns id/path/title (scaffolding skipped)/cwd/mtime/size; missing tree → empty (no throw); a `.jsonl.zst` sibling is skipped; a cwd-less rollout → `(unknown)` project with `cwd: null`. Plus pure `parseCodexSessionMeta` cases.
- [x] 6.2 Add `__tests__/codex-parse-layer.test.ts`: response_item mapping (user/assistant/function_call+output) with an `event_msg` mirror present asserts no duplication; `shell` normalized to `Bash` with nonzero exit → `error`; a user `message` with an `input_image` part → `nonTextContent.blockTypes` contains `image` while a pure-text turn is unmarked; missing/`.zst` path → `[]`.

## 7. Validation

- [x] 7.1 `npm run typecheck` clean.
- [x] 7.2 `npm run build` clean.
- [x] 7.3 `npx vitest run --testTimeout=20000` from repo root — all prior 219 tests plus the new codex tests green (fake-adapter assertion updated).
- [x] 7.4 `node "…/rasen.js" validate codex-session-reader --strict` passes.
