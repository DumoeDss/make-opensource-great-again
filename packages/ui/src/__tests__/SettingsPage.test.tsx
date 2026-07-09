// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { SettingsPage } from '../components/SettingsPage';
import type { CustomProviderInput, KeyStatusMap, ProviderTarget } from '../api/types';

afterEach(cleanup);

const FAKE_KEY = 'sk-FAKEfakeFAKEfake0123456789abcdef';

const DEEPSEEK: ProviderTarget = {
  id: 'deepseek',
  name: 'DeepSeek',
  apiFormat: 'openai',
  apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  models: ['deepseek-v4'],
};

/**
 * A stateful fake ApiClient: custom providers + key status live in mutable maps
 * so a create/set/delete + refresh reflects in the next render.
 */
function makeClient(): ApiClient {
  const custom = new Map<string, ProviderTarget>();
  const keys: KeyStatusMap = {};
  const client = {
    getHealth: vi.fn(async () => ({ name: 'mosga-daemon', version: '0.1.0' })),
    getPreflight: vi.fn(async () => ({
      dataRepoConfigured: false,
      gitAvailable: true,
      ghAvailable: true,
      ghAuthenticated: true,
      repoClean: true,
    })),
    listProviders: vi.fn(async () => [DEEPSEEK, ...custom.values()]),
    listCustomProviders: vi.fn(async () => [...custom.values()]),
    getKeyStatus: vi.fn(async () => ({ ...keys })),
    createCustomProvider: vi.fn(async (input: ProviderTarget) => {
      custom.set(input.id, { ...input });
      return { ...input };
    }),
    updateCustomProvider: vi.fn(async (id: string, fields: Omit<ProviderTarget, 'id'>) => {
      const updated = { ...fields, id };
      custom.set(id, updated);
      return updated;
    }),
    deleteCustomProvider: vi.fn(async (id: string) => {
      custom.delete(id);
    }),
    setProviderKey: vi.fn(async (id: string) => {
      keys[id] = { configured: true };
    }),
    clearProviderKey: vi.fn(async (id: string) => {
      delete keys[id];
    }),
  } as unknown as ApiClient;
  return client;
}

describe('SettingsPage — custom providers', () => {
  it('adds a custom provider via the four-format form and lists it', async () => {
    const client = makeClient();
    const { getByTestId, findByTestId } = render(<SettingsPage client={client} />);

    fireEvent.change(getByTestId('custom-provider-id'), { target: { value: 'my-llm' } });
    fireEvent.change(getByTestId('custom-provider-name'), { target: { value: 'My LLM' } });
    fireEvent.change(getByTestId('custom-provider-base-url'), {
      target: { value: 'https://api.example.com' },
    });
    fireEvent.change(getByTestId('custom-provider-models'), { target: { value: 'm-1, m-2' } });
    fireEvent.change(getByTestId('custom-provider-format'), { target: { value: 'gemini' } });
    fireEvent.click(getByTestId('custom-provider-submit'));

    await waitFor(() => {
      expect(client.createCustomProvider).toHaveBeenCalledWith({
        id: 'my-llm',
        name: 'My LLM',
        apiFormat: 'gemini',
        apiBaseUrl: 'https://api.example.com',
        models: ['m-1', 'm-2'],
      });
    });
    // The new provider appears with edit/delete controls.
    await findByTestId('provider-edit-my-llm');
    await findByTestId('provider-delete-my-llm');
  });

  it('edits then deletes a custom provider', async () => {
    const client = makeClient();
    await client.createCustomProvider({
      id: 'my-llm',
      name: 'My LLM',
      apiFormat: 'openai',
      apiBaseUrl: 'https://api.example.com',
      models: ['m-1'],
    } satisfies CustomProviderInput);
    const { getByTestId, findByTestId } = render(<SettingsPage client={client} />);

    fireEvent.click(await findByTestId('provider-edit-my-llm'));
    // Form is populated; id is locked in edit mode.
    expect((getByTestId('custom-provider-id') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(getByTestId('custom-provider-name'), { target: { value: 'Renamed' } });
    fireEvent.click(getByTestId('custom-provider-submit'));
    await waitFor(() => {
      expect(client.updateCustomProvider).toHaveBeenCalledWith(
        'my-llm',
        expect.objectContaining({ name: 'Renamed' }),
      );
    });

    fireEvent.click(await findByTestId('provider-delete-my-llm'));
    await waitFor(() => {
      expect(client.deleteCustomProvider).toHaveBeenCalledWith('my-llm');
    });
  });

  it('presets are shown without an edit control', async () => {
    const client = makeClient();
    const { findByTestId, queryByTestId } = render(<SettingsPage client={client} />);
    await findByTestId('provider-row-deepseek');
    expect(queryByTestId('provider-edit-deepseek')).toBeNull();
    expect(queryByTestId('provider-delete-deepseek')).toBeNull();
  });
});

describe('SettingsPage — write-only key entry', () => {
  it('sets a key then shows configured status only, never the key value', async () => {
    const client = makeClient();
    const { getByTestId, findByTestId, container } = render(<SettingsPage client={client} />);

    // Before: not configured, an input is present.
    const status = await findByTestId('key-status-deepseek');
    expect(status.textContent).toContain('未配置');

    fireEvent.change(getByTestId('key-input-deepseek'), { target: { value: FAKE_KEY } });
    fireEvent.click(getByTestId('key-set-deepseek'));

    await waitFor(() => {
      expect(client.setProviderKey).toHaveBeenCalledWith('deepseek', FAKE_KEY);
    });

    // After: configured status + clear button, and the key value is nowhere in the DOM.
    await findByTestId('key-clear-deepseek');
    expect((await findByTestId('key-status-deepseek')).textContent).toContain('已配置');
    expect(container.innerHTML).not.toContain(FAKE_KEY);
  });

  it('clears a configured key', async () => {
    const client = makeClient();
    await client.setProviderKey('deepseek', FAKE_KEY);
    const { findByTestId } = render(<SettingsPage client={client} />);

    fireEvent.click(await findByTestId('key-clear-deepseek'));
    await waitFor(() => {
      expect(client.clearProviderKey).toHaveBeenCalledWith('deepseek');
    });
  });

  it('rotates a configured key in place via 更换密钥, never showing the stored value', async () => {
    const client = makeClient();
    await client.setProviderKey('deepseek', FAKE_KEY);
    const { getByTestId, findByTestId, queryByTestId, container } = render(
      <SettingsPage client={client} />,
    );

    // Configured: no input rendered until the replace affordance is used.
    await findByTestId('key-replace-deepseek');
    expect(queryByTestId('key-input-deepseek')).toBeNull();

    fireEvent.click(getByTestId('key-replace-deepseek'));
    // The input reveals empty — never the stored key.
    const input = (await findByTestId('key-input-deepseek')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain(FAKE_KEY);

    const NEW_KEY = 'sk-ROTATErotateROTATErotate9876543210';
    fireEvent.change(input, { target: { value: NEW_KEY } });
    fireEvent.click(getByTestId('key-set-deepseek'));

    await waitFor(() => {
      expect(client.setProviderKey).toHaveBeenCalledWith('deepseek', NEW_KEY);
    });
    // Back to configured status with the input hidden again; no key value in the DOM.
    await findByTestId('key-clear-deepseek');
    expect(queryByTestId('key-input-deepseek')).toBeNull();
    expect(container.innerHTML).not.toContain(NEW_KEY);
  });
});
