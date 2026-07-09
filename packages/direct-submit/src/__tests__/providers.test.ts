import { describe, expect, it } from 'vitest';

import { ALLOWED_PRESET_IDS, listProviders, resolveProvider, type UserTarget } from '../providers.js';

const USER_TARGET: UserTarget = {
  id: 'my-llm',
  name: 'My LLM',
  apiFormat: 'gemini',
  apiBaseUrl: 'https://api.example.com',
  models: ['m-1'],
};

describe('preset allowlist', () => {
  it('lists exactly the 7 allowlisted presets (6 open-model vendors) plus user targets', () => {
    const ids = listProviders().map((p) => p.id);
    for (const id of ALLOWED_PRESET_IDS) expect(ids).toContain(id);
    // Non-open-source / relay presets are excluded.
    expect(ids).not.toContain('openai');
    expect(ids).not.toContain('anthropic');
    expect(ids).not.toContain('gemini');
    expect(ids).not.toContain('openrouter');
    // Only allowlisted presets are present (no leakage of the full 29).
    expect(ids.length).toBe(ALLOWED_PRESET_IDS.length);
  });

  it('appends user targets to the list unchanged', () => {
    const ids = listProviders([USER_TARGET]).map((p) => p.id);
    expect(ids).toContain('my-llm');
    expect(ids.length).toBe(ALLOWED_PRESET_IDS.length + 1);
  });

  it('resolves an allowlisted preset', () => {
    expect(resolveProvider('deepseek')?.id).toBe('deepseek');
    expect(resolveProvider('minimax')?.apiFormat).toBe('anthropic');
  });

  it('does NOT resolve a non-allowlisted preset (UI-hiding alone is insufficient)', () => {
    // `openai` is a real @omnicross/contracts preset but off the allowlist.
    expect(resolveProvider('openai')).toBeUndefined();
    expect(resolveProvider('openrouter')).toBeUndefined();
  });

  it('always resolves a user target regardless of the allowlist', () => {
    expect(resolveProvider('my-llm', [USER_TARGET])?.id).toBe('my-llm');
  });
});
