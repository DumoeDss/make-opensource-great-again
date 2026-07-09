## Why

The mosga v0.1 pipeline (采集 → 脱敏 → 人工确认 → 导出/PR) needs a foundation before any sanitization or UI can be built: a TypeScript ESM monorepo, a shared data contract that every later slice aligns to, and a read-only layer that discovers and parses local Claude Code session JSONL. The session-parsing logic already exists, battle-tested, in elftia (the initiator holds copyright and has authorized direct MIT reuse), so this slice extracts it into standalone MIT packages rather than rewriting it. This is slice 1 of 4 and has no prerequisites; sanitizer, review-UI, and publisher all consume its package interfaces.

## What Changes

- Establish an npm-workspaces TypeScript ESM monorepo at the repo root (tsup build, vitest tests, shared `tsconfig.base.json`), mirroring omnicross's layout conventions. No CI yet — that is slice 4.
- Add `@mosga/contracts`: zod schemas + inferred TS types for (a) the reader-layer references (`CliProjectRef`, `CliSessionRef`, the parsed-message shape) and (b) the **sanitized-session intermediate format** — the envelope (contributor alias, tool version, sanitization-ruleset version, timestamp, license, source CLI) plus a body kept structurally isomorphic to the original Claude Code JSONL so 出口② replay stays possible. Ships with `SCHEMA.md` documenting the format, banner-marked "待发起人腹稿校准" (schema is the initiator's un-finalized draft, Open Question 1).
- Add `@mosga/session-readers`: elftia's session discovery/parsing layer extracted verbatim (filesystem scan, JSONL parser, Claude meta helpers, the path encoder with its one electron dependency stripped via the documented `os.homedir()`/env fallback), plus a leaner `CliSourceAdapter` interface and the **Claude Code adapter only**. The adapter interface must accommodate Codex/Cursor adapters later without changing.
- Add a **non-text-content marker layer** around the reused parser: elftia's parser silently drops image/binary content blocks; mosga must preserve/flag them (design doc: mark-not-strip, no silent truncation) so the downstream ⚠ human-review path has something to act on.

## Capabilities

### New Capabilities

- `monorepo-skeleton`: npm-workspaces TypeScript ESM monorepo scaffolding — workspace resolution, shared tsconfig, per-package tsup ESM+d.ts build, root vitest runner. The reproducible toolchain foundation all packages build on.
- `session-contracts`: the `@mosga/contracts` package — zod schemas and TS types for reader references and the sanitized-session intermediate envelope, plus the `SCHEMA.md` design record. The shared data contract every v0.1 slice aligns to.
- `session-readers`: the `@mosga/session-readers` package — read-only discovery + parsing of Claude Code session JSONL, the `CliSourceAdapter` pluggable interface + registry, the Claude Code adapter, and the non-text-content marker layer.

### Modified Capabilities

<!-- None — this is the first change in the repo; openspec/specs/ is empty. -->

## Impact

- **New source tree**: `package.json` (workspaces), `tsconfig.base.json`, `vitest.config.ts`, `packages/contracts/`, `packages/session-readers/` at the repo root (currently only `LICENSE`, `README.md`, `openspec/`).
- **New dev/runtime dependencies**: `zod` (runtime, contracts); `typescript`, `tsup`, `vitest` (dev). No electron, no DB, no network — everything here is pure Node FS read + in-memory parsing.
- **Licensing**: elftia code (GPLv3 upstream) is relicensed MIT into these packages under the initiator's copyright authorization; provenance recorded in design.md and package headers.
- **Downstream contract**: `@mosga/sanitizer` (slice 2) consumes `ParsedMessage[]` / the sanitized-session envelope; `@mosga/daemon` + `@mosga/ui` (slice 3) and `@mosga/publisher` (slice 4) consume the same contracts package. Interface names fixed here are load-bearing for all siblings.
- **Out of scope** (later slices, must not bleed in): sanitization/rule engines, daemon/HTTP, React UI, GitHub PR/publishing, CI workflows, and the Codex/Cursor adapters (interface accommodates them; implementations deferred to v1.x).
