/**
 * `CliSourceAdapter` — the pluggable per-CLI enumeration + parse-delegate seam.
 *
 * Reshaped from elftia's adapter interface (design D4): mosga keeps ONLY
 * enumeration + metadata + a clean parse delegate. elftia's GUI/DB surface —
 * `read` (display IR), `resolveTranscriptPathById`, memory
 * (`locateMemoryDir`/`memoryDirPath`), subagent, continue, and
 * `registryBackendId` (native-resume) — is dropped; those are dead surface for
 * an export pipeline. Adding a new CLI (Codex/Cursor, v1.x) = registering one
 * adapter against this interface, with no change to consumers or the registry.
 *
 * Enumeration is pure-FS read-only: methods take their roots as arguments (so
 * they are unit-testable against a temp dir) and never throw on a missing /
 * unreadable tree — they return what they can.
 */
import type { CliProjectRef, CliSessionRef, ParsedMessage } from '@mosga/contracts';

export interface CliSourceAdapter {
  /** Stable source id (e.g. `"claude-code"`). */
  readonly id: string;
  /** Human label (e.g. `"Claude Code"`). */
  readonly displayName: string;

  /** Absolute root dir(s) this CLI writes sessions under, for a given home dir. */
  locateRoots(home: string): string[];

  /** Enumerate projects (decoded-cwd groupings). Pure FS read; never throws. */
  listProjects(roots: string[]): CliProjectRef[];

  /**
   * Enumerate a project's sessions (metadata only — NO transcript parse).
   * `roots` is threaded in (rather than re-derived inside the adapter) so
   * enumeration stays pure + unit-testable against a temp dir.
   */
  listSessions(roots: string[], project: CliProjectRef): CliSessionRef[];

  /** Absolute transcript path for a ref (the locator fed to the parser). */
  resolveTranscriptPath(ref: CliSessionRef): string;

  /**
   * Parse the transcript → `ParsedMessage[]` via the clean parse path (NOT a
   * display-IR projection). Returns `[]` on a missing/unreadable/zero-message
   * file. Pure FS read; never throws.
   */
  parseTranscriptToMessages(transcriptPath: string): ParsedMessage[];
}
