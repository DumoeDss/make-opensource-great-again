# Tasks — mosga-v01-readers

Ordered, individually completable. Fixtures are ALWAYS hand-crafted fake data — never real session data. Capabilities: `monorepo-skeleton`, `session-contracts`, `session-readers`.

## 1. Monorepo skeleton

- [x] 1.1 Create root `package.json` (`"private": true`, `"type": "module"`, `"workspaces": ["packages/*"]`, scripts: `build`, `test`, `typecheck`). Add dev deps `typescript`, `tsup`, `vitest`.
- [x] 1.2 Create `tsconfig.base.json` at root: NodeNext module + moduleResolution, `target` ES2022+, `strict: true`, `declaration: true`, `composite`/paths as needed for workspace resolution.
- [x] 1.3 Create root `vitest.config.ts` discovering tests across `packages/*`.
- [x] 1.4 Create empty `packages/contracts/` and `packages/session-readers/` package scaffolds (each: `package.json` with `@mosga/*` name, `exports`/`main`/`module`/`types`, `tsconfig.json` extending the base, `tsup.config.ts` emitting ESM + d.ts, `src/index.ts`).
- [x] 1.5 Wire `@mosga/session-readers` to depend on `@mosga/contracts` via the workspace protocol; verify install links them locally with no registry fetch.
- [x] 1.6 Add one smoke test per package and confirm the root `test` command runs all workspaces green; confirm `build` emits `dist/` ESM + `.d.ts` and `typecheck` passes with zero errors under strict.

## 2. @mosga/contracts — schemas + types

- [x] 2.1 Add `zod` as a runtime dependency of `@mosga/contracts`.
- [x] 2.2 Implement primitive schemas/types: `role` union (`user|assistant|system`) and `ToolCallSchema` = `{ id, name, input, status: 'completed'|'error', result? }`.
- [x] 2.3 Implement `CliProjectRefSchema` `{ sourceId, key, cwd: nullable, label }` and `CliSessionRefSchema` `{ sourceId, projectKey, id, path, title: nullable, cwd: nullable, updatedAt, sizeBytes }` + inferred types.
- [x] 2.4 Implement `ParsedMessageSchema` (superset of elftia `ParsedAgentMessage`): required `{ sdkUuid, parentUuid: nullable, role, content, sdkMessageType, timestamp }` + optional `toolCalls`, `toolResults`, `thinking`, `isSidechain`, `commandName`, `commandMessage`, `commandArgs`, and the optional non-text marker field (used by task 4.3).
- [x] 2.5 Implement `SanitizedSessionSchema` per design D7: `schemaVersion`, `meta` (`contributorAlias`, `sourceCli` extensible enum, `toolVersion`, `sanitizationRulesetVersion: nullable`, `exportedAt`, `license: nullable`, `sanitized`), `session` (`sessionId`, `sourceId`, `projectKey`, `cwd: nullable`, `title: nullable`, `updatedAt`), `messages: ParsedMessage[]`.
- [x] 2.6 Export all schemas + inferred types from the package entry (`src/index.ts`).
- [x] 2.7 Write `packages/contracts/SCHEMA.md`: top banner **"待发起人腹稿校准"**, then field-by-field docs of the envelope/meta/session/message, the isomorphism-for-replay guarantee, and the note that dataset slicing lives in the export layer.
- [x] 2.8 Vitest: valid objects parse; a missing required field is rejected; an out-of-set `role` is rejected; a reader-shaped envelope (`sanitized:false`, `sanitizationRulesetVersion:null`) validates; `sourceCli:"claude-code"` accepted. Add a test (or doc-lint) asserting every field documented in `SCHEMA.md` exists in `SanitizedSessionSchema` (no doc/code drift).

## 3. @mosga/session-readers — extract elftia parse path

- [x] 3.1 Copy `types.ts` shapes (`JsonlEntry`, `ContentBlock`) into the package; re-type `ParsedAgentMessage`'s role/tool fields onto `@mosga/contracts` primitives (D2) — no `@shared/chat-types` dependency. Add a package-header comment recording elftia origin + MIT relicense authorization.
- [x] 3.2 Copy `filesystem.ts` verbatim (`scanClaudeProjectDirs`, `listSessionFilesInProject`, `readSessionEntries`, `extractSummaryFromEntries`, `extractCwdFromEntries`, `probeProjectCwd`); confirm home resolution already uses `os.homedir()`/env fallback (no electron).
- [x] 3.3 Copy `JsonlParser.ts` (`deduplicateEntries`, `parseContentBlocks`, `parseJsonlEntriesToAgentMessages`, helpers) and `JsonlClaudeMeta.ts` (`parseLocalCommandPayload`, `buildLocalCommandDisplayText`, `summarizeToolUseResult`) verbatim.
- [x] 3.4 Copy `encodeProjectPath` from `claudeProjectsPaths.ts` verbatim; DROP the electron import and the `getClaudeProjectsDir`/`getSdkJsonlPath`/`hasResumableSdkJsonl` helpers not needed by mosga (D3).
- [x] 3.5 Vitest for the extracted layer: `encodeProjectPath` Windows-path fixture (`C:\...\@waifuoid\...` → `C--...--waifuoid-...`, no collapse/trim); `deduplicateEntries` keeps latest-by-uuid; `parseJsonlEntriesToAgentMessages` preserves `thinking` + `isSidechain` and merges tool results into tool calls; malformed JSONL line is skipped not fatal. All against hand-crafted fake JSONL.

## 4. @mosga/session-readers — adapter, registry, marker layer

- [x] 4.1 Define the leaner `CliSourceAdapter` interface (D4): `id`, `displayName`, `locateRoots`, `listProjects`, `listSessions`, `resolveTranscriptPath`, `parseTranscriptToMessages`. No `read`/memory/subagent/continue/`registryBackendId`.
- [x] 4.2 Implement the Claude Code adapter (reshape elftia's `claudeCodeAdapter.ts`): `locateRoots` → `[<home>/.claude/projects]`; `listProjects` (skip session-less dirs, probe cwd, label fallback to slug); `listSessions` (title via summary→first-user-turn→null, `updatedAt`=mtime, `sizeBytes`); `resolveTranscriptPath` → `ref.path`; `parseTranscriptToMessages` → the wrapper from 4.3.
- [x] 4.3 Implement the non-text marker wrapper `parseClaudeSession(transcriptPath)` (D5): run the reused parse path (`readSessionEntries` → `deduplicateEntries` → `parseJsonlEntriesToAgentMessages`), then scan the raw deduplicated entries for content blocks that are NOT text/thinking/tool_use/tool_result and stamp the non-text marker on the matching `ParsedMessage`. Reused parser stays verbatim. Return `[]` on missing/unreadable/zero-message file.
- [x] 4.4 Implement the adapter `registry`: `getAdapter(id)` / `listAdapters()`, registering ONLY `claudeCodeAdapter` for v0.1.
- [x] 4.5 Export the interface, adapter, registry, `parseClaudeSession`, and `encodeProjectPath` from the package entry.
- [x] 4.6 Vitest with a hand-crafted temp `projects/` tree: two project dirs (one with sessions, one empty-but-for-index) → session-less one omitted; title fallback chain (summary / first-user-turn / null); missing projects root → empty list, no throw; an `image`-block message gets the non-text marker while a pure-text message does not; `getAdapter("claude-code")` returns the adapter and `listAdapters()` includes it.
- [x] 4.7 Vitest: register a FAKE second adapter against the interface and enumerate it via the registry WITHOUT modifying `CliSourceAdapter` — proves the interface accommodates Codex/Cursor later.

## 5. Validation

- [x] 5.1 Run root `typecheck`, `build`, and `test` — all green; confirm no test reads a real `~/.claude/projects/` tree.
- [x] 5.2 Run `openspec validate --change mosga-v01-readers` and fix any errors until it passes.
