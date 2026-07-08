import {
  getAllProviderPresets,
  getPresetById,
  type PresetProviderTemplate,
} from '@omnicross/contracts';

/**
 * A selectable target: an `@omnicross/contracts` preset or a user-added target.
 * `apiFormat` routes conversion — `anthropic` sends native, anything else (the
 * common open-model case, e.g. DeepSeek) converts to OpenAI shape.
 */
export interface ProviderTarget {
  id: string;
  name: string;
  apiFormat: string;
  apiBaseUrl: string;
  models: string[];
}

/** The wire shape of a user-added target (config file / options). NEVER a key. */
export interface UserTarget {
  id: string;
  name: string;
  apiFormat: string;
  apiBaseUrl: string;
  models: string[];
}

function fromPreset(p: PresetProviderTemplate): ProviderTarget {
  return {
    id: p.id,
    name: p.name,
    // `apiFormat` is the current field; fall back to the deprecated `apiType`,
    // then default to openai (the majority open-model shape).
    apiFormat: p.apiFormat ?? p.apiType ?? 'openai',
    apiBaseUrl: p.api_base_url,
    models: p.models,
  };
}

/**
 * The key-free provider list: open-model presets plus user-added targets. Never
 * includes key material (presets carry none; user targets are id/name/format
 * only — the key is resolved separately, server-side, at send time).
 */
export function listProviders(userTargets: UserTarget[] = []): ProviderTarget[] {
  const presets = getAllProviderPresets().map(fromPreset);
  return [...presets, ...userTargets];
}

/** Resolve a target by id from presets first, then user-added targets. */
export function resolveProvider(
  id: string,
  userTargets: UserTarget[] = [],
): ProviderTarget | undefined {
  const preset = getPresetById(id);
  if (preset) return fromPreset(preset);
  return userTargets.find((t) => t.id === id);
}

/** True when the target expects a native Anthropic request (no conversion). */
export function isAnthropicFormat(target: ProviderTarget): boolean {
  return target.apiFormat === 'anthropic';
}
