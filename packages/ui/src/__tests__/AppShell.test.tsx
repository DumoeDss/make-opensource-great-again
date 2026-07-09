// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import { AppShell } from '../components/shell/AppShell';

afterEach(cleanup);

const client = {
  getHealth: vi.fn(async () => ({ name: 'mosga-daemon', version: '0.1.0' })),
  listProviders: vi.fn(async () => []),
  getPreflight: vi.fn(async () => ({
    dataRepoConfigured: false,
    gitAvailable: true,
    ghAvailable: false,
    ghAuthenticated: false,
    repoClean: true,
  })),
} as unknown as ApiClient;

describe('AppShell', () => {
  it('switches the content area when the settings nav is activated', () => {
    const { getByTestId, queryByTestId } = render(
      <AppShell client={client}>
        <div data-testid="journey-content">journey</div>
      </AppShell>,
    );

    // Contribute is active by default → the journey children render.
    expect(getByTestId('journey-content')).toBeTruthy();
    expect(queryByTestId('settings-page')).toBeNull();

    fireEvent.click(getByTestId('nav-settings'));
    expect(getByTestId('settings-page')).toBeTruthy();
    expect(queryByTestId('journey-content')).toBeNull();

    fireEvent.click(getByTestId('nav-contribute'));
    expect(getByTestId('journey-content')).toBeTruthy();
  });
});
