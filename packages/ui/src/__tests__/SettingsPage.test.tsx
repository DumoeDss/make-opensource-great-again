// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { SettingsPage } from '../components/SettingsPage';
import type {
  CustomProviderInput,
  KeyStatusMap,
  ProviderTarget,
  PublicationStatus,
} from '../api/types';
import {
  blockedStatus,
  directStatus,
  forkConfirmationStatus,
  loginRequiredStatus,
  publicationError,
  publicationTarget,
  unconfiguredStatus,
} from './publicationFixtures';

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
function makeClient(initialPublication: PublicationStatus = unconfiguredStatus()): ApiClient {
  const custom = new Map<string, ProviderTarget>();
  const keys: KeyStatusMap = {};
  let publication = initialPublication;
  const client = {
    getHealth: vi.fn(async () => ({ name: 'mosga-daemon', version: '0.1.0' })),
    inspectPublication: vi.fn(async () => ({ ok: true as const, data: publication })),
    configurePublicationTarget: vi.fn(async (repository: string) => {
      publication = {
        ...directStatus(),
        target: publicationTarget({ slug: repository }),
        pushRepository: repository,
      };
      return { ok: true as const, data: publication };
    }),
    clearPublicationTarget: vi.fn(async () => {
      publication = unconfiguredStatus(publication.revision + 1);
      return { ok: true as const, data: publication };
    }),
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

describe('SettingsPage — GitHub publication target', () => {
  it('saves the exact owner/repo draft and renders returned server truth', async () => {
    const client = makeClient();
    render(<SettingsPage client={client} />);
    const input = await screen.findByLabelText('Canonical repository');
    fireEvent.change(input, { target: { value: 'community/dataset' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));
    await waitFor(() => {
      expect(client.configurePublicationTarget).toHaveBeenCalledWith('community/dataset');
    });
    expect(await screen.findByText('Ready · direct')).toBeTruthy();
    expect(screen.getAllByText('community/dataset')).toHaveLength(2);
  });

  it('treats an HTTP-success blocked status as blocked, including no-target', async () => {
    const client = makeClient();
    client.configurePublicationTarget = vi.fn(async () => ({
      ok: true as const,
      data: blockedStatus(false),
    }));
    render(<SettingsPage client={client} />);
    fireEvent.change(await screen.findByLabelText('Canonical repository'), {
      target: { value: 'community/dataset' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect(await screen.findByText('Blocked')).toBeTruthy();
    expect(screen.getByText(/details are unavailable/i)).toBeTruthy();
    expect(screen.queryByText('community/dataset')).toBeNull();
  });

  it('keeps invalid input editable and displays curated server validation', async () => {
    const client = makeClient();
    const invalid = publicationError({
      code: 'invalid_target',
      phase: 'target',
      message: 'Choose one public repository in owner/repo form.',
      retryable: false,
      recovery: 'Correct the repository slug and save again.',
    });
    client.configurePublicationTarget = vi.fn(async () => ({ ok: false as const, error: invalid }));
    render(<SettingsPage client={client} />);
    const input = await screen.findByLabelText('Canonical repository');
    fireEvent.change(input, { target: { value: 'https://github.com/community/dataset' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'Save and validate' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(input, { target: { value: 'community/dataset' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and validate' }));
    expect((await screen.findByRole('alert')).textContent).toContain(invalid.message);
    expect((input as HTMLInputElement).value).toBe('community/dataset');
  });

  it('refreshes from the daemon and clears with explicit confirmation', async () => {
    const client = makeClient(directStatus());
    render(<SettingsPage client={client} />);
    await screen.findByText('Ready · direct');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(client.inspectPublication).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Clear target' }));
    expect(screen.getByText(/invalidates unsubmitted previews/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('clear-publication-target-ok-btn'));
    await waitFor(() => expect(client.clearPublicationTarget).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Unconfigured')).toBeTruthy();
    expect(screen.getByText(/Existing remote forks, branches, and pull requests were not deleted/i))
      .toBeTruthy();
  });

  it.each([
    [unconfiguredStatus(), 'Unconfigured'],
    [loginRequiredStatus(), 'Login required'],
    [forkConfirmationStatus(), 'Fork confirmation required'],
    [directStatus(), 'Ready · direct'],
    [blockedStatus(), 'Blocked'],
  ] as const)('renders the exact %s readiness state', async (status, label) => {
    render(<SettingsPage client={makeClient(status)} />);
    expect(await screen.findByText(label)).toBeTruthy();
    cleanup();
  });

  it('has keyboard labels and no legacy or forbidden publication disclosure', async () => {
    const client = makeClient({
      ...directStatus(),
      target: publicationTarget({
        url: 'https://example.invalid/raw-target-url',
        slug: `${'longowner'.repeat(8)}/${'longrepo'.repeat(10)}`,
      }),
    });
    const { container } = render(<SettingsPage client={client} />);
    const repositoryInput = await screen.findByLabelText('Canonical repository');
    expect(repositoryInput.getAttribute('aria-describedby')).toBe(
      'publication-repository-help',
    );
    const saveButton = screen.getByRole('button', { name: 'Save and validate' });
    expect(saveButton.parentElement?.className).toContain('flex-col');
    expect(saveButton.parentElement?.className).toContain('sm:flex-row');
    const publicationPanel = await screen.findByTestId('settings-publication-target');
    expect(publicationPanel.textContent).not.toContain('https://example.invalid/raw-target-url');
    const forbiddenDisclosure = new RegExp(
      [
        ['data', 'repository'].join(' '),
        'workspace',
        ['remote', 'name'].join(' '),
        ['git', 'push'].join(' '),
        'stdout',
        'stderr',
        ['ghp', '_'].join(''),
      ].join('|'),
      'i',
    );
    expect(publicationPanel.textContent).not.toMatch(forbiddenDisclosure);
    expect(container.textContent).not.toContain(['--data', 'repo'].join('-'));
  });
});
