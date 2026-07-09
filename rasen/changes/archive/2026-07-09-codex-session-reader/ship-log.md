# Ship Log — codex-session-reader

## What shipped

Codex source adapter + rollout parser for `@mosga/session-readers`, registered
alongside the existing claude-code adapter:

- `packages/session-readers/src/adapter/codexAdapter.ts` — date-tree walk under
  `~/.codex/sessions` (bounded depth, pure-FS, never-throw), recognizing
  `rollout-*-<uuid>.jsonl[.zst]` (`.zst` recognized but not enumerated as a
  session, no decompression). Bounded prefix read (≤128 KB / 60 lines) derives
  `session_meta` id/cwd/title with filename-UUID fallback. `listProjects`
  dedups by `cwd` (label = basename); cwd-less rollouts group under a
  synthetic `(unknown)` project.
- `packages/session-readers/src/parsers/codexRollout.ts` — maps
  `response_item` lines only (ignores `event_msg`/`turn_context`/
  `session_meta`), synthesizes `sdkUuid`/`parentUuid: null`, stamps non-text
  content parts (e.g. `input_image`) inline onto `nonTextContent.blockTypes`
  instead of dropping them, and handles `compacted` via the lower-risk
  fallback (summary as a normal assistant message).
- `packages/session-readers/src/parsers/codexToolNormalize.ts` — pure helpers:
  `normalizeCodexTool` (`shell`/`shell_command`→`Bash` with wrapper-stripped
  command, `update_plan`→`TodoWrite`) and `unwrapCodexOutput`
  (`{output, metadata}`→ stdout + `isError` on nonzero `exit_code`).
- `packages/session-readers/src/parseCodexSession.ts` — entry point mirroring
  `parseClaudeSession.ts`; never throws, returns `[]` for missing/unreadable
  files or `.jsonl.zst` paths.
- Registration: `registry.ts` registers `codexAdapter` after claude-code;
  `index.ts` exports `codexAdapter`, `parseCodexSession`,
  `parseCodexSessionMeta`.
- Provenance fix (surfaced in review): `packages/contracts/src/envelope.ts`
  adds `'codex'` to `SOURCE_CLI_VALUES`; `packages/daemon/src/envelope.ts`
  `buildEnvelope` now derives `sourceCli` from `ref.sourceId` instead of a
  hardcoded `'claude-code'` (fails closed — throws — on an unmapped
  `sourceId`, by design; future adapter onboarding must extend the enum).

## Commit

- Ship commit: `9820a56` on branch `worktree-codex-session-reader`
  ("feat(session-readers): codex source adapter + rollout parser —
  enumeration, non-text markers, provenance enum (codex-session-reader)")

## Validation results

- `npm run typecheck` — clean (all 7 workspaces).
- `npm run build` — clean (all workspaces, including `@mosga/ui` vite build).
- `npx vitest run --testTimeout=20000` — **245/245 passed**, 46 test files
  (219 prior + 26 new: codex-adapter, codex-parse-layer, envelope
  provenance, fake-adapter registry-set update).
- `node rasen.js validate codex-session-reader --strict` — valid.

## Review verdict

Round 1 review: 0 Blocker, 2 Major (M1 provenance `sourceCli` hardcoded to
`claude-code`; M2 scaffolding-skip dropped the image marker), 3 Minor (m3
unknown-role unmarked; m4 typeless part dropped; m5 test gaps), 1 Trivial
(t6, accepted). All Major/Minor findings fixed by fixer-codex-reader and
verified by LEAD from disk (typecheck clean, vitest 245/245, strict valid).
Non-author re-review (reviewer-codex-reader, warm delta re-review) confirmed
**CLEAN** — round 1 re-review, 0 open Blocker/Major.

Source of truth for the above: `rasen/changes/codex-session-reader/auto-run.json`
(`openFindings: []`, `reReview: "CLEAN — all findings RESOLVED..."`). Note:
a standalone `review-report.md` referenced by the reviewer's log entry was
not present on disk in this worktree at ship time; `auto-run.json` was used
as the authoritative record instead. Flagging this as a process gap for the
retro, not a ship blocker — no open findings exist in the recorded state.

## Accepted-known items (not fixed, deliberate)

- **t6**: helper duplication of scaffolding/text-detection logic across
  `codexRollout.ts` and `codexAdapter.ts` — deliberate split to keep each
  file under the ~300-line util cap.
- **buildEnvelope fail-closed enum coupling**: `buildEnvelope` throws on a
  `sourceId` not present in `SOURCE_CLI_VALUES`. Currently unreachable (only
  `claude-code` and `codex` are registered), but any future adapter must
  remember to extend the enum or provenance derivation will hard-fail at
  runtime rather than silently mislabeling.
