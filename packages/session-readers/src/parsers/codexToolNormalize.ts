/**
 * codexToolNormalize — pure helpers for `codexRollout`:
 *   - `normalizeCodexTool(name, input)` maps codex tool names + arg shapes to
 *     the shared tool vocabulary (`shell`/`shell_command` → `Bash`,
 *     `update_plan` → `TodoWrite`); everything else passes through verbatim.
 *   - `unwrapCodexOutput(raw)` peels codex's `{output, metadata}` tool-output
 *     envelope down to the inner stdout string and derives an error flag from
 *     `metadata.exit_code` (nonzero → error). Never throws; never loses bytes.
 *
 * PROVENANCE: adapted (near-verbatim) from elftia
 * (`packages/desktop/app/main/services/agent-core/engine/cli/native-reader/codexToolNormalize.ts`,
 * MIT reuse under the initiator's authorization — the same authorization already
 * exercised for the Claude `JsonlParser`/`types` extraction). These are pure,
 * side-effect-free functions exercised directly by the codex parser's unit tests.
 */

/** Result of normalizing a codex tool call: shared-vocabulary name + reshaped input. */
export interface NormalizedTool {
  name: string;
  input: Record<string, unknown>;
}

/** Result of unwrapping a codex tool-output envelope. */
export interface UnwrappedOutput {
  /** Displayed result text (inner stdout when an envelope, else verbatim). */
  result: string;
  /** True when `metadata.exit_code` is present and nonzero. */
  isError: boolean;
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** Coerce a codex plan/todo status to a shared `TodoStatus`; unknown → `pending`. */
function mapTodoStatus(status: unknown): string {
  return typeof status === 'string' && TODO_STATUSES.has(status) ? status : 'pending';
}

/**
 * Host-shell executables codex uses to wrap a command. Compared against the
 * lowercased basename of `parts[0]`, so both bare names (`bash`, `cmd`) and
 * `.exe` variants are listed. Covers the Unix shells AND the Windows hosts
 * (`powershell`, `pwsh`, `cmd`) codex spawns by default on that platform.
 */
const HOST_SHELL_EXECUTABLES = new Set([
  'bash',
  'sh',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
]);

/**
 * Lowercased basename of a command-token path. Strips any directory prefix
 * using BOTH separators (`/` and `\`) so absolute paths like
 * `C:\Windows\System32\cmd.exe` and `/usr/bin/bash` reduce to `cmd.exe` /
 * `bash`. The drive prefix (`C:`) falls away with the last `\` split. Pure.
 */
function shellBasename(token: string): string {
  const lastSlash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
  return base.toLowerCase();
}

/**
 * Is `flag` a recognized host-shell wrapper flag for `parts[1]`?
 *   - dash-prefixed (`-lc`, `-c`, `-Command`, `-NoProfile`, …) used by
 *     bash/sh/powershell/pwsh, OR
 *   - cmd's forward-slash flag `/c` or `/C` (cmd does NOT use a leading dash, so
 *     a dash-only guard would silently miss it).
 * Pure; case-sensitive only where it matters (the `/c`/`/C` literal pair).
 */
function isWrapperFlag(flag: string): boolean {
  return flag.startsWith('-') || flag === '/c' || flag === '/C';
}

/**
 * Reduce a codex `shell` command to a single human-readable string.
 *   - string → kept as-is
 *   - host-shell wrapper → the last element (the actual command), verbatim:
 *       `["bash","-lc","<cmd>"]` / `["sh","-c","<cmd>"]`
 *       `["powershell","-Command","<cmd>"]` / `["pwsh","-Command","<cmd>"]`
 *         (and the `.exe` variants)
 *       `["cmd","/c","<cmd>"]` / `["cmd.exe","/C","<cmd>"]`
 *   - any other array → space-joined
 *
 * A wrapper is detected when `parts.length >= 3` AND the lowercased basename of
 * `parts[0]` is in `HOST_SHELL_EXECUTABLES` AND `parts[1]` is a wrapper flag.
 * Byte-preserving (returns the trailing element unchanged); never throws.
 */
function joinShellCommand(command: unknown): string {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const parts = command.map((c) => (typeof c === 'string' ? c : String(c ?? '')));
  if (parts.length === 0) return '';
  if (
    parts.length >= 3 &&
    HOST_SHELL_EXECUTABLES.has(shellBasename(parts[0])) &&
    isWrapperFlag(parts[1])
  ) {
    return parts[parts.length - 1];
  }
  return parts.join(' ');
}

/** Reshape codex `shell`/`shell_command` input into the shared `Bash` shape. */
function reshapeShellInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { command: joinShellCommand(input.command) };
  // Preserve a human-readable hint if codex supplied one.
  if (typeof input.description === 'string') out.description = input.description;
  else if (typeof input.workdir === 'string') out.description = input.workdir;
  return out;
}

/** Reshape codex `update_plan` input into the shared `TodoWrite` shape. */
function reshapeUpdatePlanInput(input: Record<string, unknown>): Record<string, unknown> {
  const plan = input.plan;
  if (!Array.isArray(plan)) return { todos: [] };
  const todos = plan
    .map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const step = typeof e.step === 'string' ? e.step : '';
      return { content: step, status: mapTodoStatus(e.status), activeForm: step };
    })
    .filter((t) => t.content.length > 0);
  return { todos };
}

/**
 * Map a codex tool name + input to the shared vocabulary.
 *   - `shell`, `shell_command` → `Bash` (`{command: <joined string>, description?}`)
 *   - `update_plan` → `TodoWrite` (`{todos: [{content, status, activeForm}]}`)
 *   - anything else → unchanged (verbatim name + input, incl. `apply_patch`)
 */
export function normalizeCodexTool(name: string, input: Record<string, unknown>): NormalizedTool {
  if (name === 'shell' || name === 'shell_command') {
    return { name: 'Bash', input: reshapeShellInput(input) };
  }
  if (name === 'update_plan') {
    return { name: 'TodoWrite', input: reshapeUpdatePlanInput(input) };
  }
  return { name, input };
}

/** Stringify a value for display without throwing. */
function toResultString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Read a numeric `metadata.exit_code`; returns null when absent / non-numeric. */
function readExitCode(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const code = (metadata as Record<string, unknown>).exit_code;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

/**
 * Unwrap a codex tool-output value. codex commonly wraps tool stdout in an
 * envelope `{ "output": "<stdout>", "metadata": { "exit_code": N, ... } }`,
 * delivered either as a JSON STRING or as an object. When the envelope is
 * present, surface the inner `output` as the displayed result and derive an
 * error flag from a nonzero `exit_code`. Otherwise pass the value through
 * verbatim with `isError: false`. Never throws on malformed JSON; never drops
 * bytes (falls back to the original text).
 */
export function unwrapCodexOutput(raw: unknown): UnwrappedOutput {
  let value: unknown = raw;

  // A JSON-string envelope: parse, but keep the original string on failure.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        value = JSON.parse(raw);
      } catch {
        return { result: raw, isError: false };
      }
    } else {
      return { result: raw, isError: false };
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ('output' in obj) {
      const exitCode = readExitCode(obj.metadata);
      return {
        result: toResultString(obj.output),
        isError: exitCode != null && exitCode !== 0,
      };
    }
  }

  // Not an envelope — verbatim (string passthrough handled above; objects/arrays
  // stringified for display).
  return { result: toResultString(raw), isError: false };
}
