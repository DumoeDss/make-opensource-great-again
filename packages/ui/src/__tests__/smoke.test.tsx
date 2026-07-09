// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../App';
import type { ApiClient } from '../api/client';
import type { ProjectAnnotation, SessionRef } from '../api/types';
import { makeReport } from './_fixtures';

afterEach(cleanup);

const project: ProjectAnnotation = {
  sourceId: 'claude-code',
  key: 'proj-a',
  cwd: '/home/me/proj-a',
  label: 'proj-a',
  gitRemote: 'https://github.com/me/proj-a',
  recommended: true,
  recommendReason: 'public git remote',
};

const session: SessionRef = {
  sourceId: 'claude-code',
  projectKey: 'proj-a',
  id: 's1',
  path: '/home/me/proj-a/s1.jsonl',
  title: 'My Session',
  cwd: '/home/me/proj-a',
  updatedAt: Date.now(),
  sizeBytes: 2048,
};

const client = {
  getHealth: async () => ({ name: 'mosga-daemon', version: '0.1.0' }),
  listSources: async () => [{ id: 'claude-code', displayName: 'Claude Code' }],
  listProjects: async () => ({ projects: [project], totalCount: 1, recommendedCount: 1, showAll: false }),
  listSessions: async () => [session],
  createReview: async () => ({ reviewId: 'r1', report: makeReport([]), rulesetWarnings: [] }),
  listProviders: async () => [],
  getPreflight: async () => ({
    dataRepoConfigured: false,
    gitAvailable: true,
    ghAvailable: false,
    ghAuthenticated: false,
    repoClean: true,
  }),
} as unknown as ApiClient;

describe('@mosga/ui smoke', () => {
  it('walks the tree/grid picker into the review journey', async () => {
    const { getByText, getByTestId } = render(<App client={client} />);

    // NavRail shell + its two destinations.
    expect(getByTestId('nav-rail')).toBeTruthy();
    expect(getByTestId('nav-contribute')).toBeTruthy();
    expect(getByTestId('nav-settings')).toBeTruthy();

    // Contribute is active by default → the tree-navigation picker.
    expect(getByText('选择要审阅的会话')).toBeTruthy();
    await waitFor(() => expect(getByTestId('source-claude-code')).toBeTruthy());

    // Expand the source → its project lazy-loads.
    fireEvent.click(getByTestId('source-claude-code'));
    await waitFor(() => expect(getByTestId('project-proj-a')).toBeTruthy());

    // Open the folder → the session card grid loads.
    fireEvent.click(getByTestId('project-proj-a'));
    await waitFor(() => expect(getByTestId('session-card-s1')).toBeTruthy());

    // Select a session → the selection bar surfaces its CTA.
    fireEvent.click(getByTestId('session-card-s1'));
    expect(getByTestId('selection-bar')).toBeTruthy();

    // Start review → the queue-aware journey container takes over.
    fireEvent.click(getByTestId('start-review'));
    await waitFor(() => expect(getByTestId('stepper')).toBeTruthy());
  });
});
