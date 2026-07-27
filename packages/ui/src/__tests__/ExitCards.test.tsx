// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type { PublicationStatus } from '../api/types';
import { ExitCards } from '../components/journey/ExitCards';
import { makeReport } from './_fixtures';
import {
  blockedStatus,
  directStatus,
  existingForkStatus,
  forkConfirmationStatus,
  loginRequiredStatus,
  publicationError,
  publicationPreview,
  unconfiguredStatus,
} from './publicationFixtures';

afterEach(cleanup);

function fakeClient(status: PublicationStatus = directStatus()): ApiClient {
  return {
    inspectPublication: vi.fn(async () => ({ ok: true as const, data: status })),
    previewPublication: vi.fn(async () => ({
      ok: true as const,
      data: publicationPreview(),
    })),
    submitPublication: vi.fn(),
    listProviders: vi.fn(async () => []),
  } as unknown as ApiClient;
}

function renderCards(
  client: ApiClient,
  over: Partial<React.ComponentProps<typeof ExitCards>> = {},
) {
  const props: React.ComponentProps<typeof ExitCards> = {
    client,
    reviewId: 'review-one',
    gate: makeReport([]).gate,
    exported: null,
    exporting: false,
    onExport: vi.fn(),
    onSubmitted: vi.fn(),
    onPublished: vi.fn(),
    onJumpToReviewIssue: vi.fn(),
    ...over,
  };
  return { props, ...render(<ExitCards {...props} />) };
}

describe('ExitCards publication integration', () => {
  it.each([
    ['login required', loginRequiredStatus(), ['community/dataset', 'main']],
    [
      'fork confirmation',
      forkConfirmationStatus(),
      ['contributor', 'community/dataset', 'contributor/dataset'],
    ],
    [
      'ready direct',
      directStatus(),
      ['contributor', 'community/dataset', 'main', 'a'.repeat(40), 'direct', '7'],
    ],
    [
      'ready existing fork',
      existingForkStatus(),
      [
        'contributor',
        'community/dataset',
        'main',
        'a'.repeat(40),
        'fork',
        'contributor/dataset',
        '7',
      ],
    ],
  ])('shows every required safe compact fact for %s', async (_name, status, facts) => {
    const { getByTestId } = renderCards(fakeClient(status));
    await waitFor(() =>
      expect(getByTestId('exit-one-state').textContent).toContain(facts[0]),
    );
    const text = getByTestId('exit-one-state').textContent ?? '';
    for (const fact of facts) expect(text).toContain(fact);
  });

  it.each([
    ['unconfigured', unconfiguredStatus()],
    ['login required', loginRequiredStatus()],
    ['blocked without a target', blockedStatus(false)],
  ])(
    'keeps direct submit and sanitized export available when publication is %s',
    async (_name, status) => {
      const onExport = vi.fn();
      const { getByTestId } = renderCards(fakeClient(status), { onExport });

      await waitFor(() =>
        expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(true),
      );
      expect(getByTestId('exit-two')).toBeTruthy();
      expect((getByTestId('export-secondary') as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(getByTestId('export-secondary'));
      expect(onExport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['ready', directStatus()],
    ['fork confirmation required', forkConfirmationStatus()],
  ])('opens the shared wizard for %s with exactly one review id', async (_name, status) => {
    const client = fakeClient(status);
    const { getByTestId, findByTestId } = renderCards(client);

    await waitFor(() =>
      expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('exit-one-cta'));
    await findByTestId('publication-preview');

    expect(client.previewPublication).toHaveBeenCalledTimes(1);
    expect(client.previewPublication).toHaveBeenCalledWith(['review-one']);
  });

  it('keeps donation affirmation separate from final public confirmation', async () => {
    const client = fakeClient();
    let proceed: (() => void) | undefined;
    const requireAffirm = vi.fn((next: () => void) => {
      proceed = next;
    });
    const { getByTestId, findByTestId } = renderCards(client, { requireAffirm });

    await waitFor(() =>
      expect((getByTestId('exit-one-cta') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(getByTestId('exit-one-cta'));
    expect(requireAffirm).toHaveBeenCalledTimes(1);
    expect(client.previewPublication).not.toHaveBeenCalled();

    proceed?.();
    await findByTestId('publication-preview');
    fireEvent.click(getByTestId('wizard-open-confirmation'));
    expect(await findByTestId('publication-confirm')).toBeTruthy();
    expect(client.submitPublication).not.toHaveBeenCalled();
    expect(requireAffirm).toHaveBeenCalledTimes(1);
  });

  it('replaces the parent card status after target freshness recovery', async () => {
    const inspectPublication = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: directStatus() })
      .mockResolvedValueOnce({ ok: true, data: blockedStatus(false) });
    const client = fakeClient();
    client.inspectPublication = inspectPublication;
    client.submitPublication = vi.fn(async () => ({
      ok: false as const,
      error: publicationError({
        code: 'target_changed',
        phase: 'preview',
        retryable: false,
      }),
    }));
    const { getByTestId, findByTestId } = renderCards(client);
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('Ready'));
    fireEvent.click(getByTestId('exit-one-cta'));
    await findByTestId('publication-preview');
    fireEvent.click(getByTestId('wizard-open-confirmation'));
    fireEvent.click(await findByTestId('publication-confirm-ok-btn'));
    await waitFor(() => expect(getByTestId('exit-one-state').textContent).toContain('Blocked'));
    expect(getByTestId('exit-one-state').textContent).not.toContain('community/dataset');
    expect(
      (await screen.findByRole('button', {
        name: 'Create new preview',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(inspectPublication).toHaveBeenCalledTimes(2);
  });

  it('does not render transport authority or exact-content canaries', async () => {
    const { container, findByTestId } = renderCards(fakeClient());
    fireEvent.click(await screen.findByTestId('exit-one-cta'));
    await findByTestId('publication-preview');

    expect(container.textContent).not.toMatch(
      /workspace|C:\\secret|\/home\/secret|remote name|stdout|stderr|gh pr create|token-value|exact-file-contents/i,
    );
  });
});
