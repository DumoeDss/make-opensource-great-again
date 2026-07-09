import { describe, expect, it } from 'vitest';

import type { CliProjectRef, CliSessionRef, ParsedMessage } from '@mosga/contracts';

import { getAdapter, listAdapters, registerAdapter } from '../adapter/registry.js';
import type { CliSourceAdapter } from '../adapter/types.js';

// Proves the leaner `CliSourceAdapter` interface + registry accommodate a
// SECOND CLI (the future Codex/Cursor case) WITHOUT modifying either — a fake
// adapter is written against the same interface, registered, and enumerated.
const fakeCodexAdapter: CliSourceAdapter = {
  id: 'fake-codex',
  displayName: 'Fake Codex',
  locateRoots(home: string): string[] {
    return [`${home}/.fake-codex/sessions`];
  },
  listProjects(): CliProjectRef[] {
    return [{ sourceId: 'fake-codex', key: 'fake-proj', cwd: null, label: 'fake-proj' }];
  },
  listSessions(): CliSessionRef[] {
    return [];
  },
  resolveTranscriptPath(ref: CliSessionRef): string {
    return ref.path;
  },
  parseTranscriptToMessages(): ParsedMessage[] {
    return [];
  },
};

describe('registry accommodates a second adapter', () => {
  it('registers the built-in adapters by default', () => {
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toEqual(['claude-code', 'codex']);
  });

  it('enumerates a fake second adapter after registration, no interface change', () => {
    registerAdapter(fakeCodexAdapter);
    expect(getAdapter('fake-codex')).toBe(fakeCodexAdapter);
    const ids = listAdapters().map((a) => a.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('fake-codex');
  });
});
