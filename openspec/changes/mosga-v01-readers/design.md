## Context

mosga (Make-OpenSource-Great-Again) v0.1 builds 出口① (the HuggingFace public-dataset channel) of the approved two-channel design: 采集 → 脱敏 → 人工确认 → 导出/PR. The LEAD decomposed it into four strictly-serial child changes (readers → sanitizer → review-ui → publish). This is **slice 1, readers**, with no prerequisites; every later slice consumes its package interfaces.

Current repo state: only `LICENSE` (MIT), `README.md`, and `openspec/`. There is no build system yet. The session-parsing logic mosga needs already exists in elftia (`E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\elftia`), GPLv3 upstream but under the initiator's copyright, and the initiator has authorized direct MIT reuse (planning-context.md, 2026-07-07). omnicross (`...\elftia\omnicross`, MIT, npm-published) is the layout/tooling template.

Constraints carried in from the design doc and planning-context: TypeScript/Node ESM full stack; npm workspaces; MIT; cross-platform code (dev machine is Windows); no real session data ever committed (fixtures are hand-crafted fakes); no silent truncation of data.

## Goals / Non-Goals

**Goals:**

- Stand up a minimal, reproducible npm-workspaces TS ESM monorepo (tsup + vitest + shared tsconfig) mirroring omnicross conventions.
- Ship `@mosga/contracts`: zod schemas + types for reader references and the sanitized-session intermediate envelope, plus a `SCHEMA.md` design record marked pending calibration.
- Ship `@mosga/session-readers`: elftia's discovery/parse layer extracted MIT, a leaner `CliSourceAdapter` + registry, the Claude Code adapter, and a non-text-content marker layer.
- Fix the interface names, package boundaries, and schema field list that all three sibling slices depend on.

**Non-Goals:**

- No sanitization, rule engines, or alias mapping (slice 2).
- No daemon, HTTP, or React UI (slice 3).
- No publishing, GitHub PR, HF sync, or CI workflows (slice 4).
- No Codex/Cursor adapter implementations (the interface must accommodate them; implementations are v1.x).
- No use of elftia's display-IR `read` path, memory/subagent/continue features, or DB.
- No actual npm publish of `@mosga/*` packages in this slice.

## Decisions

### D1 — Extract elftia's parse path, not its display path

elftia's `ClaudeNativeTranscriptReader` has two entry points: `read()` (projects to the `ChatMessagePage` display IR, pulling in `buildInMemoryEventRows`, `AgentEventDisplayProjection`, `claudeSubagentScan`, and `@shared/chat-types`) and `parseToMessages()` (stops at `ParsedAgentMessage[]`). mosga takes **only the `parseToMessages` path**: `readSessionEntries` → `deduplicateEntries` → `parseJsonlEntriesToAgentMessages`. This severs all coupling to elftia's renderer and DB. *Alternative considered:* reuse `read()` for richer output — rejected; it drags in the entire elftia display layer and IPC types for zero benefit to an export pipeline.

**Files extracted (verbatim where possible):**
- `routers/legacy/filesystem.ts` — `scanClaudeProjectDirs`, `listSessionFilesInProject`, `readSessionEntries`, `extractSummaryFromEntries`, `extractCwdFromEntries`, `probeProjectCwd`. Pure Node, zero electron/DB.
- `routers/legacy/parsers/JsonlParser.ts` — `deduplicateEntries`, `parseContentBlocks`, `parseJsonlEntriesToAgentMessages`, helpers.
- `routers/legacy/parsers/JsonlClaudeMeta.ts` — `parseLocalCommandPayload`, `buildLocalCommandDisplayText`, `summarizeToolUseResult`.
- `routers/legacy/types.ts` — `JsonlEntry`, `ContentBlock`, `ParsedAgentMessage` (the last imports `ChatMessageRole`/`ToolCall` from `@shared/chat-types` — see D2).
- `agent-core/engine/cli/native-reader/claudeProjectsPaths.ts` — only `encodeProjectPath` (see D3).
- `capabilities/code-cli/sources/adapters/claudeCodeAdapter.ts` + `sources/types.ts` (`CliSourceAdapter`) — reshaped per D4.

### D2 — Redefine the two tiny cross-package types locally

`ParsedAgentMessage` and the parser import `ChatMessageRole` (`'user' | 'assistant' | 'system'`) and `ToolCall` from elftia's `@shared/chat-types`. Rather than depend on that package, mosga redefines the minimal shapes it actually uses in `@mosga/contracts`: `role` as the three-value union, and `ToolCall` as `{ id: string; name: string; input: Record<string, unknown>; status: 'completed' | 'error'; result?: string }` (the fields `parseJsonlEntriesToAgentMessages` reads/writes). *Alternative:* pull elftia's `@shared` package as a dep — rejected; it is not MIT-clean-scoped and carries far more than these two types.

### D3 — Strip the one electron dependency

`claudeProjectsPaths.ts` imports `app` from `electron` only inside `getClaudeProjectsDir()` (`app.getPath('home')`). `encodeProjectPath` — the only function mosga needs — is electron-free. mosga copies `encodeProjectPath` verbatim and, wherever a projects-root is needed, resolves home via `os.homedir() || process.env.USERPROFILE || process.env.HOME` (the exact fallback `filesystem.ts` already uses). The electron import is dropped entirely.

### D4 — A leaner CliSourceAdapter

elftia's `CliSourceAdapter` carries GUI/DB concerns mosga has no use for: `read` (display IR), `resolveTranscriptPathById`, memory (`locateMemoryDir`/`memoryDirPath`), subagent, continue, and `registryBackendId` (native-resume). mosga's interface keeps enumeration + metadata + the clean parse delegate:

```
interface CliSourceAdapter {
  readonly id: string;
  readonly displayName: string;
  locateRoots(home: string): string[];
  listProjects(roots: string[]): CliProjectRef[];
  listSessions(roots: string[], project: CliProjectRef): CliSessionRef[];
  resolveTranscriptPath(ref: CliSessionRef): string;
  parseTranscriptToMessages(transcriptPath: string): ParsedMessage[];
}
```

A small `registry` (`getAdapter(id)`, `listAdapters()`) makes adding a CLI = registering one adapter. The `roots`-threaded `listProjects`/`listSessions` signatures (service owns `home`, computes roots once) are kept from elftia because they keep enumeration pure and unit-testable against a temp dir. *Alternative:* copy elftia's full interface — rejected; the extra methods would be dead surface siblings must ignore.

### D5 — Non-text-content marker as a thin wrapper (mark, not strip)

elftia's `parseContentBlocks` only extracts `text` / `thinking` / `tool_use` / `tool_result`; any `image`/binary/unknown block is silently dropped — acceptable for a chat renderer, forbidden here (design doc: mark-not-strip, no silent truncation; images have no automatic scan defense so a human must see them). mosga keeps the reused parser **verbatim** and adds a thin wrapper (`parseClaudeSession`) that, alongside calling the reused parser, scans the raw deduplicated entries for non-text blocks and stamps a marker on the matching `ParsedMessage`. Keeping the reuse verbatim preserves byte-for-byte parse fidelity and isolates the mosga-specific behavior. *Alternative:* fork and edit `parseContentBlocks` — rejected; it entangles mosga's marker concern with reused code and complicates future elftia re-syncs.

### D6 — contracts vs session-readers boundary

`@mosga/contracts` is pure schemas/types with no I/O (mirrors `@omnicross/contracts`): reader references (`CliProjectRef`, `CliSessionRef`), `ParsedMessage`, `ToolCall`/role primitives, and the `SanitizedSession` envelope + `SCHEMA.md`. `@mosga/session-readers` depends on contracts and holds all FS + parsing + adapter logic. This is the same core/contracts split omnicross uses and keeps the shared data contract dependency-light for every downstream slice.

### D7 — Sanitized-session envelope shape (the load-bearing schema)

Per planning-context "Schema 假设", the v0.1 intermediate = sanitized Claude Code JSONL superset + top-level meta, body kept isomorphic to the source JSONL so 出口② replay works; dataset slicing deferred to the export layer. Field list:

```
SanitizedSession {
  schemaVersion: string                       // mosga intermediate schema version, e.g. "0.1.0"
  meta: {
    contributorAlias: string                  // deterministic per-session alias of the contributor
    sourceCli: enum("claude-code", ...)       // extensible; only claude-code in v0.1
    toolVersion: string                       // mosga tool version that produced this
    sanitizationRulesetVersion: string | null // null out of readers; sanitizer (slice2) stamps
    exportedAt: string                        // ISO-8601
    license: string | null                    // dataset license (Open Q2, 待定)
    sanitized: boolean                        // false out of readers; true after sanitizer gate
  }
  session: {
    sessionId: string
    sourceId: string                          // adapter id
    projectKey: string
    cwd: string | null                        // raw here; normalized/aliased in slice2
    title: string | null
    updatedAt: number
  }
  messages: ParsedMessage[]                    // isomorphic to source JSONL for replay
}
```

Readers emit `sanitized:false`, `sanitizationRulesetVersion:null`. `SCHEMA.md` documents this field-by-field with a top banner **"待发起人腹稿校准"**, because the initiator's dataset schema is an un-finalized draft (design doc Open Question 1). Siblings MUST treat these names as fixed unless the initiator calibrates the draft.

### D8 — Minimal, no-CI toolchain

Root `package.json` (`private`, `type:module`, `workspaces:["packages/*"]`), `tsconfig.base.json` (NodeNext ESM, strict, declaration), per-package tsup config (ESM + d.ts), root `vitest.config.ts`. No GitHub Actions, no lint gate wired as CI — slice 4 owns CI. Keep dev deps to `typescript`, `tsup`, `vitest`; runtime dep `zod` in contracts only.

## Risks / Trade-offs

- **Silently dropping non-text content would breach the design doc's core safety premise** → D5 adds the marker layer as a spec'd, tested requirement (image-block fixture asserts the flag).
- **Schema churn once the initiator calibrates their draft** → the envelope is versioned (`schemaVersion`) and `SCHEMA.md` is banner-marked pending calibration; siblings key off the field list recorded in planning-context so a later change is a coordinated version bump, not silent drift.
- **Relicensing provenance disputes** → package headers + design.md record the elftia origin and the initiator's MIT authorization; only files confirmed under the initiator's copyright are copied (planning-context reuse map is the verified set).
- **Cross-platform path bugs (dev is Windows, code must run on POSIX)** → all path work uses `node:path`; `encodeProjectPath` has a Windows-path fixture; home resolution uses `os.homedir()` with env fallback.
- **Interface too lean for Codex/Cursor later** → a fake second adapter in tests proves the interface + registry accommodate a second CLI without modification (spec scenario), de-risking the v1.x adapters.
- **Reused parser drift from upstream elftia** → keeping the reuse verbatim (no edits) and layering mosga behavior in wrappers keeps a future re-sync mechanical.

## Migration Plan

Greenfield; nothing to migrate. Sequencing within the slice: (1) monorepo skeleton + smoke tests green, (2) `@mosga/contracts` (schemas + SCHEMA.md), (3) `@mosga/session-readers` (extract → adapter/registry → marker layer), each with vitest fixtures, (4) `openspec validate`. Rollback is deleting the added files; no external state is touched. No publish in this slice.

## Open Questions

- **Sanitized-session schema detail** (design doc Open Q1): the initiator's dataset draft is not yet provided. Resolution: ship the D7 shape banner-marked pending calibration; a later coordinated `schemaVersion` bump absorbs the real draft.
- **Dataset license** (Open Q2): `meta.license` is nullable for now; value decided before slice 4 publish.
- **ToS handling of assistant content** (Open Q3): does not affect readers (we parse faithfully); it constrains what the export layer emits. Flagged so slice 4 accounts for it.
- Exact `schemaVersion` starting value and whether `ParsedMessage` should retain the raw non-text block payload (bytes) vs. only a presence marker — leaning presence marker + block type in readers, with full-payload retention decided when slice 3's ⚠ preview UI defines what it must render.
