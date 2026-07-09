// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import type { ApiClient } from '../api/client';

afterEach(cleanup);

const emptyClient = {
  getHealth: async () => ({ name: 'mosga-daemon', version: '0.1.0' }),
  listSources: async () => [{ id: 'claude-code', displayName: 'Claude Code' }],
  listProjects: async () => ({ projects: [], totalCount: 0, recommendedCount: 0, showAll: false }),
  listSessions: async () => [],
} as unknown as ApiClient;

describe('@mosga/ui smoke', () => {
  it('renders the NavRail shell and the picker entry screen', async () => {
    const { getByText, getByTestId } = render(<App client={emptyClient} />);
    // NavRail shell + its two destinations.
    expect(getByTestId('nav-rail')).toBeTruthy();
    expect(getByTestId('nav-contribute')).toBeTruthy();
    expect(getByTestId('nav-settings')).toBeTruthy();
    // Contribute is active by default → the Picker entry screen.
    expect(getByText('Select a session to review')).toBeTruthy();
    await waitFor(() => expect(getByTestId('source-select')).toBeTruthy());
  });
});
