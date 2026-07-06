/**
 * Adapter registry — the open/closed seam for pluggable CLI sources.
 *
 * Adding a CLI (Codex/Cursor, v1.x) = registering one adapter here; consumers
 * call `getAdapter(id)` / `listAdapters()` and never change. v0.1 registers
 * ONLY the Claude Code adapter.
 */
import { claudeCodeAdapter } from './claudeCodeAdapter.js';
import type { CliSourceAdapter } from './types.js';

const adapters = new Map<string, CliSourceAdapter>();

/** Register an adapter by its id. Later registration of the same id overrides. */
export function registerAdapter(adapter: CliSourceAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** Get a registered adapter by id, or `undefined` when none is registered. */
export function getAdapter(id: string): CliSourceAdapter | undefined {
  return adapters.get(id);
}

/** All registered adapters, in registration order. */
export function listAdapters(): CliSourceAdapter[] {
  return Array.from(adapters.values());
}

registerAdapter(claudeCodeAdapter);
