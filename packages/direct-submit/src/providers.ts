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

/**
 * The open-model source-vendor allowlist: exactly the `@omnicross/contracts`
 * presets the product targets — DeepSeek, z.ai, 智谱 GLM, Kimi (Moonshot),
 * MiniMax, 小米 MiMo (two official endpoints). Every non-open-source and relay
 * preset is deliberately excluded. Enforced in BOTH `listProviders` and
 * `resolveProvider` so a preset outside it is neither shown nor submittable
 * (UI-hiding alone would let `/api/reviews/:id/submit` still accept it).
 */
export const ALLOWED_PRESET_IDS: readonly string[] = [
  'deepseek',
  'zhipu',
  'zhipu-bigmodel',
  'kimi',
  'minimax',
  'xiaomi-mimo',
  'xiaomi-mimo-anthropic',
];

function isAllowlistedPreset(id: string): boolean {
  return ALLOWED_PRESET_IDS.includes(id);
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
 * The key-free provider list: allowlisted open-model presets plus user-added
 * targets. Never includes key material (presets carry none; user targets are
 * id/name/format only — the key is resolved separately, server-side, at send
 * time). Presets outside `ALLOWED_PRESET_IDS` are filtered out here.
 */
export function listProviders(userTargets: UserTarget[] = []): ProviderTarget[] {
  const presets = getAllProviderPresets()
    .filter((p) => isAllowlistedPreset(p.id))
    .map(fromPreset);
  return [...presets, ...userTargets];
}

/**
 * Resolve a target by id from allowlisted presets first, then user-added
 * targets. A preset outside the allowlist resolves to nothing (so it can never
 * be submitted to, matching `listProviders`); user targets always resolve.
 */
export function resolveProvider(
  id: string,
  userTargets: UserTarget[] = [],
): ProviderTarget | undefined {
  if (isAllowlistedPreset(id)) {
    const preset = getPresetById(id);
    if (preset) return fromPreset(preset);
  }
  return userTargets.find((t) => t.id === id);
}

/** True when the target expects a native Anthropic request (no conversion). */
export function isAnthropicFormat(target: ProviderTarget): boolean {
  return target.apiFormat === 'anthropic';
}
