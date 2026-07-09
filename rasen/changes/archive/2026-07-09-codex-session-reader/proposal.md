## Why

`@mosga/session-readers` today discovers and parses only Claude Code sessions; the whole采集→脱敏→确认→导出 pipeline is therefore blind to any other coding CLI. The `CliSourceAdapter` seam was deliberately built (v0.1) to accept more CLIs by registering one adapter with zero consumer change. The user asked to extend reading to `codex` (and confirm the seam stays open for later CLIs), and a battle-tested codex rollout reader already exists in elftia under MIT reuse authorization — so this slice adds a **codex source adapter + codex transcript parser**, registered in the adapter registry, and nothing else.

## What Changes

- Add a **codex source adapter** (`packages/session-readers/src/adapter/codexAdapter.ts`) that enumerates `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*-<uuid>.jsonl` rollouts via a bounded, pure-FS, never-throw date-tree walk; groups sessions into projects by each rollout's `session_meta.cwd` (undecodable cwd → a synthetic `(unknown)` project); and reads each rollout's id/cwd/title from a bounded 128KB/60-line prefix.
- Add a **codex transcript parser** (`parseCodexSession.ts` + a `codexRollout` line-mapper and a `codexToolNormalize` helper) that maps codex `response_item` rollout lines (`message`/`reasoning`/`function_call`/`custom_tool_call` + their outputs) to `@mosga/contracts` `ParsedMessage[]`, ignoring the mirror `event_msg` stream, skipping `<environment_context>`/`<user_instructions>` scaffolding turns, normalizing `shell`→`Bash` / `update_plan`→`TodoWrite`, and unwrapping the `{output, metadata}` tool-output envelope (nonzero `exit_code`→error).
- **Honor the non-text-marker contract for codex**: a codex `message` content part that is not `input_text`/`output_text` (e.g. an `input_image`) is stamped with a `nonTextContent` marker on its `ParsedMessage`, never silently dropped — matching the claude parser's mark-not-strip guarantee.
- Register `codexAdapter` in the adapter registry and export it from `index.ts`, so the daemon's `/api/sources*` routes and the UI Picker pick codex up with **zero consumer change** (both already iterate `listAdapters()` / dispatch by `getAdapter(id)`; `annotateProject` keys purely off `project.cwd`, so codex's real cwd is git-probed identically and `(unknown)` is not-recommended).
- **`.jsonl.zst` policy (v0.x)**: compressed rollouts are recognized but **skipped at enumeration** — no decompression, no new native/wasm dependency. Documented limitation; adding a zstd decoder is deferred (Later).
- Update `registry.fake-adapter.test.ts`'s default-registry assertion from `['claude-code']` to `['claude-code', 'codex']` (the only existing test that pins the registered set).

## Capabilities

### New Capabilities
<!-- None — codex reading extends the existing session-readers capability rather than introducing a new one. -->

### Modified Capabilities
- `session-readers`: ADD a codex adapter enumeration requirement and a codex transcript-parsing requirement (including the codex non-text-marker scenario); MODIFY the existing "Claude Code adapter enumeration" requirement to drop its now-false "v0.1 ships ONLY this adapter" exclusivity clause (scenario titles unchanged).

## Impact

- **Code**: new `packages/session-readers/src/adapter/codexAdapter.ts`, `src/parseCodexSession.ts`, `src/parsers/codexRollout.ts`, `src/parsers/codexToolNormalize.ts`; edits to `src/adapter/registry.ts` and `src/index.ts`; new tests `__tests__/codex-adapter.test.ts` + `__tests__/codex-parse-layer.test.ts`; one assertion edit in `__tests__/registry.fake-adapter.test.ts`.
- **Consumers**: `@mosga/daemon` and `@mosga/ui` unchanged (dynamic source dispatch). No contract change — `ParsedMessage`/`CliProjectRef`/`CliSessionRef` already accommodate codex.
- **Dependencies**: none added (`.zst` deliberately unsupported this slice to avoid a zstd dependency).
- **Provenance/licensing**: codex parser + tool-normalize adapted from elftia (`codexRolloutParser.ts` / `codexToolNormalize.ts`, MIT reuse under the initiator's authorization); recorded in design.md and file headers.
- **Tests**: existing 219 must stay green; the fake-adapter default-set assertion is updated as part of this change (the only regression the registration causes).
