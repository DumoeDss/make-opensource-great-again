// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type {
  CreateReviewResponse,
  ProjectAnnotation,
  ProjectsResponse,
  SessionRef,
} from '../api/types';
import { SessionPicker } from '../components/picker/SessionPicker';
import { makeReport } from './_fixtures';

afterEach(cleanup);

function proj(sourceId: string, key: string): ProjectAnnotation {
  return {
    sourceId,
    key,
    cwd: `/home/${key}`,
    label: key,
    gitRemote: 'https://github.com/me/x',
    recommended: true,
    recommendReason: 'public git remote',
  };
}

function sess(projectKey: string, id: string, over: Partial<SessionRef> = {}): SessionRef {
  return {
    sourceId: 'src-a',
    projectKey,
    id,
    path: `/home/${projectKey}/${id}.jsonl`,
    title: `Sess ${id}`,
    cwd: `/home/${projectKey}`,
    updatedAt: 0,
    sizeBytes: 1024,
    ...over,
  };
}

/** A stub with sane empty defaults; override the methods each test drives. */
function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    getHealth: vi.fn(async () => ({ name: 'mosga-daemon', version: '0.1.0' })),
    listSources: vi.fn(async () => [
      { id: 'src-a', displayName: 'Source A' },
      { id: 'src-b', displayName: 'Source B' },
    ]),
    listProjects: vi.fn(async () => ({ projects: [], totalCount: 0, recommendedCount: 0, showAll: false })),
    listSessions: vi.fn(async () => []),
    createReview: vi.fn(),
    setDisposition: vi.fn(),
    batch: vi.fn(),
    setNonText: vi.fn(),
    getGate: vi.fn(),
    exportReview: vi.fn(),
    listProviders: vi.fn(async () => []),
    estimateSubmit: vi.fn(),
    submit: vi.fn(),
    getPreflight: vi.fn(),
    publishPlan: vi.fn(),
    publishStage: vi.fn(),
    publishSubmit: vi.fn(),
    ...over,
  } as ApiClient;
}

describe('SessionPicker tree', () => {
  it('lazy-loads a source’s projects once on expand, then loads sessions on project click', async () => {
    const listProjects = vi.fn(
      async (sourceId: string): Promise<ProjectsResponse> => ({
        projects: sourceId === 'src-a' ? [proj('src-a', 'a1'), proj('src-a', 'a2')] : [],
        totalCount: 2,
        recommendedCount: 2,
        showAll: false,
      }),
    );
    const listSessions = vi.fn(async () => [sess('a1', 's1'), sess('a1', 's2')]);
    const client = fakeClient({ listProjects, listSessions });

    const { getByTestId } = render(<SessionPicker client={client} onQueueCreated={vi.fn()} />);
    await waitFor(() => expect(getByTestId('source-src-a')).toBeTruthy());

    fireEvent.click(getByTestId('source-src-a'));
    await waitFor(() => expect(getByTestId('project-a1')).toBeTruthy());
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledWith('src-a', false);

    // Collapse then re-expand → cache-on-expand means no second fetch.
    fireEvent.click(getByTestId('source-src-a'));
    fireEvent.click(getByTestId('source-src-a'));
    await waitFor(() => expect(getByTestId('project-a1')).toBeTruthy());
    expect(listProjects).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId('project-a1'));
    await waitFor(() => expect(getByTestId('session-card-s1')).toBeTruthy());
    expect(listSessions).toHaveBeenCalledWith('src-a', 'a1');
  });
});

describe('SessionPicker selection', () => {
  it('toggles cards, selects all in a folder, and accumulates across folders', async () => {
    const listProjects = vi.fn(
      async (sourceId: string): Promise<ProjectsResponse> => ({
        projects: sourceId === 'src-a' ? [proj('src-a', 'a1')] : [proj('src-b', 'b1')],
        totalCount: 1,
        recommendedCount: 1,
        showAll: false,
      }),
    );
    const listSessions = vi.fn(async (_s: string, key: string) =>
      key === 'a1' ? [sess('a1', 's1'), sess('a1', 's2')] : [sess('b1', 's3', { sourceId: 'src-b' })],
    );
    const client = fakeClient({ listProjects, listSessions });

    const { getByTestId, queryByTestId } = render(
      <SessionPicker client={client} onQueueCreated={vi.fn()} />,
    );
    await waitFor(() => expect(getByTestId('source-src-a')).toBeTruthy());

    fireEvent.click(getByTestId('source-src-a'));
    await waitFor(() => expect(getByTestId('project-a1')).toBeTruthy());
    fireEvent.click(getByTestId('project-a1'));
    await waitFor(() => expect(getByTestId('session-card-s1')).toBeTruthy());

    // Toggle one → selection bar appears with a count of 1.
    fireEvent.click(getByTestId('session-card-s1'));
    expect(getByTestId('selection-bar').textContent).toContain('已选 1');

    // Select-all in this folder → 2.
    fireEvent.click(getByTestId('select-all'));
    expect(getByTestId('selection-bar').textContent).toContain('已选 2');

    // Switch folders and select there → the set accumulates across folders (3).
    fireEvent.click(getByTestId('source-src-b'));
    await waitFor(() => expect(getByTestId('project-b1')).toBeTruthy());
    fireEvent.click(getByTestId('project-b1'));
    await waitFor(() => expect(getByTestId('session-card-s3')).toBeTruthy());
    fireEvent.click(getByTestId('session-card-s3'));
    expect(getByTestId('selection-bar').textContent).toContain('已选 3');

    // Clear wipes the whole cross-folder set → the bar disappears.
    fireEvent.click(getByTestId('clear-selection'));
    expect(queryByTestId('selection-bar')).toBeNull();
  });

  it('caps the selection at 20 with a hint when selecting past the cap', async () => {
    const listProjects = vi.fn(
      async (): Promise<ProjectsResponse> => ({
        projects: [proj('src-a', 'a1')],
        totalCount: 1,
        recommendedCount: 1,
        showAll: false,
      }),
    );
    const listSessions = vi.fn(async () =>
      Array.from({ length: 21 }, (_, i) => sess('a1', `s${i}`)),
    );
    const client = fakeClient({ listProjects, listSessions });

    const { getByTestId } = render(<SessionPicker client={client} onQueueCreated={vi.fn()} />);
    await waitFor(() => expect(getByTestId('source-src-a')).toBeTruthy());
    fireEvent.click(getByTestId('source-src-a'));
    await waitFor(() => expect(getByTestId('project-a1')).toBeTruthy());
    fireEvent.click(getByTestId('project-a1'));
    await waitFor(() => expect(getByTestId('session-card-s0')).toBeTruthy());

    fireEvent.click(getByTestId('select-all'));
    const bar = getByTestId('selection-bar');
    expect(bar.textContent).toContain('已选 20');
    expect(bar.textContent).toContain('最多可选 20');
  });
});

describe('SessionPicker queue creation', () => {
  async function selectTwo(getByTestId: (id: string) => HTMLElement): Promise<void> {
    await waitFor(() => expect(getByTestId('source-src-a')).toBeTruthy());
    fireEvent.click(getByTestId('source-src-a'));
    await waitFor(() => expect(getByTestId('project-a1')).toBeTruthy());
    fireEvent.click(getByTestId('project-a1'));
    await waitFor(() => expect(getByTestId('session-card-s1')).toBeTruthy());
    fireEvent.click(getByTestId('session-card-s1'));
    fireEvent.click(getByTestId('session-card-s2'));
  }

  const baseClient = (over: Partial<ApiClient>): ApiClient =>
    fakeClient({
      listProjects: vi.fn(async () => ({
        projects: [proj('src-a', 'a1')],
        totalCount: 1,
        recommendedCount: 1,
        showAll: false,
      })),
      listSessions: vi.fn(async () => [sess('a1', 's1'), sess('a1', 's2')]),
      ...over,
    });

  it('creates reviews serially in selection order and emits the queue', async () => {
    const created: Record<string, CreateReviewResponse> = {
      s1: { reviewId: 'rv-s1', report: makeReport([]), rulesetWarnings: [] },
      s2: { reviewId: 'rv-s2', report: makeReport([]), rulesetWarnings: [] },
    };
    const createReview = vi.fn(async (_s: string, _p: string, id: string) => created[id]);
    const onQueueCreated = vi.fn();
    const client = baseClient({ createReview });

    const { getByTestId } = render(
      <SessionPicker client={client} onQueueCreated={onQueueCreated} />,
    );
    await selectTwo(getByTestId);
    fireEvent.click(getByTestId('start-review'));

    await waitFor(() => expect(onQueueCreated).toHaveBeenCalledTimes(1));
    // Serial order follows selection order: s1 then s2.
    expect(createReview.mock.calls.map((c) => c[2])).toEqual(['s1', 's2']);
    const queue = onQueueCreated.mock.calls[0][0];
    expect(queue.map((q: { review: CreateReviewResponse }) => q.review.reviewId)).toEqual([
      'rv-s1',
      'rv-s2',
    ]);
  });

  it('shows a scan-progress line while creating', async () => {
    let resolveFirst: (v: CreateReviewResponse) => void = () => {};
    const createReview = vi.fn(
      (_s: string, _p: string, id: string) =>
        new Promise<CreateReviewResponse>((resolve) => {
          if (id === 's1') resolveFirst = resolve;
          else resolve({ reviewId: `rv-${id}`, report: makeReport([]), rulesetWarnings: [] });
        }),
    );
    const client = baseClient({ createReview });

    const { getByTestId } = render(<SessionPicker client={client} onQueueCreated={vi.fn()} />);
    await selectTwo(getByTestId);
    fireEvent.click(getByTestId('start-review'));

    // First create is in flight → the progress line reads 1/2.
    await waitFor(() => expect(getByTestId('create-progress').textContent).toContain('1/2'));
    resolveFirst({ reviewId: 'rv-s1', report: makeReport([]), rulesetWarnings: [] });
  });

  it('collects per-session failures and continues with the successful remainder', async () => {
    const createReview = vi.fn(async (_s: string, _p: string, id: string) => {
      if (id === 's2') throw new Error('scan boom');
      return { reviewId: `rv-${id}`, report: makeReport([]), rulesetWarnings: [] };
    });
    const onQueueCreated = vi.fn();
    const client = baseClient({ createReview });

    const { getByTestId } = render(
      <SessionPicker client={client} onQueueCreated={onQueueCreated} />,
    );
    await selectTwo(getByTestId);
    fireEvent.click(getByTestId('start-review'));

    // The failing session is listed; the queue is NOT auto-created.
    await waitFor(() => expect(getByTestId('create-failures')).toBeTruthy());
    expect(getByTestId('create-failures').textContent).toContain('scan boom');
    expect(onQueueCreated).not.toHaveBeenCalled();

    // Continue with the 1 success → the remainder becomes the queue.
    fireEvent.click(getByTestId('continue-remainder'));
    expect(onQueueCreated).toHaveBeenCalledTimes(1);
    expect(onQueueCreated.mock.calls[0][0]).toHaveLength(1);
    expect(onQueueCreated.mock.calls[0][0][0].review.reviewId).toBe('rv-s1');
  });
});
