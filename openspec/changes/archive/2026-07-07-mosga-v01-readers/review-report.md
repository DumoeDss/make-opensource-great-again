# Review report — mosga-v01-readers

Reviewer: reviewer-readers (adversarial; did not author the code).
Date: 2026-07-07.
Scope: working-tree implementation of `mosga-v01-readers` (root monorepo skeleton, `packages/contracts/`, `packages/session-readers/`) against its OpenSpec artifacts and the fixed "Planner findings — readers" contract in `openspec/changes/mosga-v01/planning-context.md`.

## Verdict

**NEEDS-FIX** — 1 Blocker.

The D5 non-text marker layer has a hole that silently drops image/binary content nested inside `tool_result` content arrays (and on any entry that does not become a `ParsedMessage`). This is the exact silent-truncation the design doc bans and the review brief pre-registered as a Blocker. Everything else — spec fidelity, elftia reuse integrity, cross-platform handling, toolchain, test honesty — is clean and passes.

Finding counts: **Blocker 1, Major 0, Minor 0, Trivial 2.**

## Commands run (real results)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS — `tsc --noEmit` on both packages, zero errors under `strict`. |
| `npx vitest run` | PASS — 5 files, **26/26 tests** green, 1.16s. |
| `npm run build` | PASS — both packages emit `dist/index.js` (ESM) + `dist/index.d.ts` via tsup. |
| `openspec validate mosga-v01-readers --strict` | PASS — "Change 'mosga-v01-readers' is valid". |
| D5 empirical probe (built dist, image nested in `tool_result.content[]`) | **Reproduced the Blocker** — `nonTextContent` marker absent on every message; the nested image dropped from the merged result text. |

Note: the diff is large (200+ lines / greenfield), which would normally trigger the multi-model adversarial pass. The review brief explicitly forbade spawning subagents, so that pass was intentionally skipped; the adversarial angle was covered manually.

---

## Findings

### [BLOCKER] Non-text content nested in `tool_result` (and on non-message entries) is silently dropped, not marked

**File:** `packages/session-readers/src/parseClaudeSession.ts:36-61`

`parseClaudeSession` scans only the **top-level** blocks of each entry's `message.content`, and keys the marker by the **raw entry's own `uuid`**. Two silent-drop paths result, both forbidden by design D5 ("mark, not strip"; no silent truncation) and by the `session-readers` spec requirement "Non-text content is marked, never silently dropped":

1. **Nested inside a `tool_result` content array.** Claude Code writes tool results as a `role:'user'` entry whose content is `[{ type:'tool_result', content:[ ...blocks... ] }]`. When a tool returns an image (a screenshot MCP tool, `Read` on an image file), that image lives at `tool_result.content[]`. The scan sees the outer block `type === 'tool_result'`, which is in `TEXT_BLOCK_TYPES`, so it `continue`s and never inspects the nested array. Meanwhile the reused `extractToolResultContent` extracts only `type === 'text'` and drops the image. Net effect: the image is gone from the export **with no `⚠` marker** for the slice-3 human-review path to catch — exactly the "images have no automatic scan defense, a human must see them" failure the design doc calls the core safety premise.

2. **On entries that never become a `ParsedMessage`.** `tool_result` rows (merged, `continue`d), `isMeta` rows, `isApiErrorMessage` rows, and no-`uuid` rows produce no output message. A non-text block sitting directly on such a row is recorded in `nonTextByUuid`, but no emitted message carries that `sdkUuid`, so the marker is discarded silently.

**Empirical proof** (ran against the built `dist`): a transcript with `tool_use(t1)` then a `tool_result(t1)` whose content nests `{type:'image'}` + `{type:'text'}` yields one message with `nonTextContent: undefined` and result text `"here is the screenshot"` — the image is silently lost, unflagged.

**Suggested fix:**
- When scanning, recurse into any block's nested `content` array (specifically `tool_result.content[]`) and collect non-text block types found there.
- Attach the marker to the message the content actually lands on. For `tool_result`-nested non-text, that is the `tool_use` message the result merges into (resolve via `tool_use_id` → the owning message's `sdkUuid`), **not** the raw `tool_result` entry's uuid. As a fallback, guarantee that any detected non-text presence is surfaced on *some* emitted message rather than dropped when its origin entry produced none.
- Add fixtures for both paths: (a) an image nested in a `tool_result` content array asserts the marker lands on the tool-call-bearing message; (b) a non-text block on a `tool_result`/`isMeta` row is still surfaced.

---

### [TRIVIAL] `sanitizeProjectSlug` is dead surface

**File:** `packages/session-readers/src/filesystem.ts:39-43`

Carried in verbatim from elftia but unused and not exported from `index.ts`. Acceptable as a consequence of the "keep reuse verbatim for mechanical re-sync" decision (D5/risk note), so leaving it is defensible; flagged only so it is a conscious choice rather than an oversight. If trimmed, do so with a comment noting the intentional divergence from upstream.

---

### [TRIVIAL] Non-idiomatic vitest alias paths

**File:** `vitest.config.ts:9-12`

The `resolve.alias` values are root-absolute-looking strings (`/packages/contracts/src`). Tests pass on this machine (Vitest resolves them against the config root), so this is not a defect. It is non-idiomatic and mildly fragile across setups; `path.resolve(__dirname, 'packages/...')` — or dropping the alias entirely, since the `@mosga/*` workspace symlinks already resolve — would be clearer. Non-blocking.

---

## What was verified clean (evidence)

**Spec fidelity (Spec axis).**
- `SanitizedSession` envelope (`packages/contracts/src/envelope.ts`) matches the planner's field list exactly: `schemaVersion`; `meta{contributorAlias, sourceCli, toolVersion, sanitizationRulesetVersion:nullable, exportedAt, license:nullable, sanitized}`; `session{sessionId, sourceId, projectKey, cwd:nullable, title:nullable, updatedAt}`; `messages: ParsedMessage[]`. Reader-shaped literal (`sanitized:false`, ruleset `null`) validates in `schemas.test.ts`.
- `ParsedMessage` (`message.ts`) is the required core + the exact optional set from the contract, plus the `nonTextContent` marker.
- `CliProjectRef` / `CliSessionRef` (`references.ts`) match, with `startedInElftia` correctly dropped.
- `CliSourceAdapter` (`adapter/types.ts`) is exactly the leaner 7-member interface (`id`, `displayName`, `locateRoots`, `listProjects`, `listSessions`, `resolveTranscriptPath`, `parseTranscriptToMessages`); elftia's `read`/memory/subagent/continue/`resolveTranscriptPathById`/`registryBackendId` are all absent.
- `SCHEMA.md` opens with the `待发起人腹稿校准` banner as its first content block, and the doc/code anti-drift test enforces every documented field exists in the schema.

**elftia reuse integrity.** Diffed against the originals under `elftia/.../services/`:
- `parsers/JsonlParser.ts`, `routers/legacy/filesystem.ts`, `routers/legacy/parsers/JsonlClaudeMeta.ts`, `routers/legacy/types.ts` — byte-for-byte identical bodies, sole changes being the D2 type-import swap (`@mosga/contracts` for `@shared/chat-types`) and added provenance headers. No behavioral drift.
- `encodeProjectPath` copied verbatim; the electron import and `getClaudeProjectsDir`/`getSdkJsonlPath`/`hasResumableSdkJsonl` helpers dropped per D3.

**Cross-platform.** `encodeProjectPath` is separator-free regex; `filesystem.ts` uses `node:path` + `os.homedir() || USERPROFILE || HOME`; adapter uses `path.join`/`path.basename`. Windows-path fixture and POSIX `cwd` fixtures both exercised.

**Test honesty.** All fixtures are hand-crafted temp-dir / in-memory fakes; base64 payloads are `ZmFrZQ==` ("fake"); aliases are `fake-*`. The one real-home primitive (`scanClaudeProjectDirs`) is never invoked by any test — enumeration tests inject a temp `root`. No real `~/.claude/projects/` read.

**Toolchain (monorepo-skeleton).** Root `package.json` is `private` + `type:module` + `workspaces:["packages/*"]`; `tsconfig.base.json` is NodeNext ESM + strict + declaration; per-package tsup emits ESM + d.ts; `.gitignore` excludes `node_modules/` and `dist/`. typecheck/build/test all green.

---

## Round 1 re-review

Reviewer: reviewer-readers. Date: 2026-07-07. Scope: delta only (the implementer's fixes to the round-1 findings), not the whole change.

**Final verdict: CLEAN** — the Blocker is resolved, both Trivials addressed, no new Blocker/Major.

### Per-finding resolution

| # | Round-1 finding | Status | Evidence |
| --- | --- | --- | --- |
| BLOCKER | Non-text nested in `tool_result` / on non-materializing rows silently dropped & unmarked | **RESOLVED** | `parseClaudeSession.ts` rewritten: `tool_result` removed from `TEXT_BLOCK_TYPES` and handled separately by recursing into `block.content[]`; markers now keyed by the target message object, resolved via a `messageByToolUseId` map (nested → the `tool_use` message the result merges into), with `ownMessage`/`lastEmitted`/`firstMessage` fallbacks so a detected block is never dropped. My original repro no longer reproduces (see below). |
| TRIVIAL | `sanitizeProjectSlug` dead surface | **RESOLVED** | `filesystem.ts:10-13` adds a header NOTE documenting the intentional verbatim retention; change is comment-only, function logic untouched. |
| TRIVIAL | Non-idiomatic vitest alias paths | **RESOLVED** | `vitest.config.ts:9` now derives absolute src paths via `fileURLToPath(new URL(...))`, portable across checkout locations. |

### Verification performed (real results)

- **Original Blocker repro, rebuilt dist** — `tool_use(t1)` + `tool_result(t1)` nesting `{type:'image'}`: now yields `nonTextContent.blockTypes = ["image"]` on the `tool_use` message, and the text portion (`"here is the screenshot"`) still merges through verbatim. Blocker gone.
- **Reused elftia parser files untouched** — diffed `JsonlParser.ts`, `JsonlClaudeMeta.ts`, `types.ts` against the elftia originals: identical modulo the documented import swap + provenance headers + ESM `.js` import extension. The fix lives entirely in the wrapper. `filesystem.ts` change is comment-only.
- **Adversarial probes (all pass):**
  - `tool_result` whose `tool_use_id` matches no tool call → nested image still surfaces on the nearest emitted message (not lost).
  - Mixed carriers in one entry set (top-level unknown `weirdblock` + nested `image` + nested `audio`) → all three consolidate onto the correct tool_use message: `["weirdblock","image","audio"]`.
  - No-`uuid` entry carrying a top-level image → surfaces on the nearest emitted message.
  - Two-levels-deep nesting is not representable in the Claude Code `tool_result` content format (flat text/image array), so single-level recursion is complete.
- **`npm run typecheck`** — PASS, zero errors.
- **`npx vitest run`** — PASS, **6 files / 28 tests** (the 2 new `non-text-marker.test.ts` cases included).
- **`npm run build`** — PASS, ESM + d.ts for both packages.
