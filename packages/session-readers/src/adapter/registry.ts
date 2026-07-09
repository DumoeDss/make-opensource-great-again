/**
 * Adapter registry — the open/closed seam for pluggable CLI sources.
 *
 * Adding a CLI (Cursor, …) = registering one adapter here; consumers call
 * `getAdapter(id)` / `listAdapters()` and never change. Registers the Claude
 * Code and Codex adapters.
 */
import { claudeCodeAdapter } from './claudeCodeAdapter.js';
import { codexAdapter } from './codexAdapter.js';
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
registerAdapter(codexAdapter);
