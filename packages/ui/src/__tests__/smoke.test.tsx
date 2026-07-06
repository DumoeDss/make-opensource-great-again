// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import type { ApiClient } from '../api/client';

afterEach(cleanup);

const emptyClient = {
  listSources: async () => [{ id: 'claude-code', displayName: 'Claude Code' }],
  listProjects: async () => ({ projects: [], totalCount: 0, recommendedCount: 0, showAll: false }),
  listSessions: async () => [],
} as unknown as ApiClient;

describe('@mosga/ui smoke', () => {
  it('renders the picker entry screen', async () => {
    const { getByText, getByTestId } = render(<App client={emptyClient} />);
    expect(getByText('Select a session to review')).toBeTruthy();
    await waitFor(() => expect(getByTestId('source-select')).toBeTruthy());
  });
});
