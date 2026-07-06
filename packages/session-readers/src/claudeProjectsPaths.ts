/**
 * Claude Code `~/.claude/projects/` path encoding.
 *
 * PROVENANCE: `encodeProjectPath` extracted VERBATIM from elftia
 * (`.../agent-core/engine/cli/native-reader/claudeProjectsPaths.ts`), MIT
 * relicensed into mosga under the initiator's copyright authorization
 * (planning-context.md, 2026-07-07). Per design D3 the electron import and the
 * `getClaudeProjectsDir`/`getSdkJsonlPath`/`hasResumableSdkJsonl` helpers (the
 * only electron-coupled surface) are DROPPED — mosga needs only the pure
 * encoder; home resolution lives in `filesystem.ts` via `os.homedir()`.
 *
 * The native `claude` CLI stores per-project session JSONL files at
 * `~/.claude/projects/<encoded-projectPath>/<sessionId>.jsonl`. The encoding
 * rule (verified empirically against the on-disk directories): every
 * non-alphanumeric character — including `:`, `\`, `/`, `.`, `@`, `-` itself —
 * is replaced with `-`. Consecutive `-`s are NOT collapsed and leading/trailing
 * `-`s are NOT stripped.
 *
 * Example: `C:\Users\Sayo\AppData\Roaming\@waifuoid\elftia\clawia`
 *       → `C--Users-Sayo-AppData-Roaming--waifuoid-elftia-clawia`
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, '-');
}
