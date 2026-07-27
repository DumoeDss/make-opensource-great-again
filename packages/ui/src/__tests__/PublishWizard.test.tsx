// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client';
import type {
  PublicationErrorBody,
  PublicationPreview,
  PublicationReceipt,
} from '../api/types';
import { PublishWizard } from '../components/journey/PublishWizard';
import {
  directStatus,
  existingForkPreview,
  onSubmitForkPreview,
  publicationError,
  publicationPreview,
  publicationReceipt,
} from './publicationFixtures';

afterEach(cleanup);

function wizardClient(
  preview: PublicationPreview = publicationPreview(),
  receipt: PublicationReceipt = publicationReceipt(),
): ApiClient {
  return {
    inspectPublication: vi.fn(async () => ({ ok: true as const, data: directStatus() })),
    previewPublication: vi.fn(async () => ({ ok: true as const, data: preview })),
    submitPublication: vi.fn(async () => ({ ok: true as const, data: receipt })),
  } as unknown as ApiClient;
}

function renderWizard(
  client: ApiClient,
  reviewIds = ['review-a'],
  onPublished = vi.fn(),
  onJumpToReviewIssue = vi.fn(),
  onRefreshStatus = vi.fn(async () => {
    const result = await client.inspectPublication();
    return result.ok ? result.data : null;
  }),
) {
  return {
    onPublished,
    onJumpToReviewIssue,
    onRefreshStatus,
    ...render(
      <PublishWizard
        client={client}
        reviewIds={reviewIds}
        onPublished={onPublished}
        onJumpToReviewIssue={onJumpToReviewIssue}
        onRefreshStatus={onRefreshStatus}
      />,
    ),
  };
}

async function openConfirmation(): Promise<void> {
  fireEvent.click(await screen.findByTestId('wizard-open-confirmation'));
  await screen.findByTestId('publication-confirm');
}

describe('shared PublishWizard preview', () => {
  it.each([
    [['review-a'], 1],
    [['review-a', 'review-b'], 2],
  ] as const)('previews %s with one collection request', async (reviewIds, count) => {
    const client = wizardClient(
      publicationPreview({ contribution: { ...publicationPreview().contribution, recordCount: count } }),
    );
    renderWizard(client, [...reviewIds]);
    await screen.findByTestId('publication-preview');
    expect(client.previewPublication).toHaveBeenCalledTimes(1);
    expect(client.previewPublication).toHaveBeenCalledWith([...reviewIds]);
    expect(screen.getAllByText(String(count)).length).toBeGreaterThan(0);
  });

  it('renders direct target, PR metadata, safe file commitments and engine pins', async () => {
    const preview = publicationPreview();
    const { container } = renderWizard(wizardClient(preview));
    await screen.findByTestId('publication-preview');
    expect(screen.getAllByText('community/dataset').length).toBeGreaterThan(0);
    expect(screen.getByText(preview.contribution.branch)).toBeTruthy();
    expect(screen.getByText('records/fixture.jsonl')).toBeTruthy();
    expect(
      screen.getAllByText(preview.contribution.files[0].contentHash).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Advanced · engine pins')).toBeTruthy();
    expect(container.textContent).not.toContain('exact-file-contents');
  });

  it('distinguishes an existing fork from an on-submit public fork', async () => {
    const existing = renderWizard(wizardClient(existingForkPreview()));
    await screen.findByTestId('publication-preview');
    expect(screen.getByText('existing')).toBeTruthy();
    expect(screen.getByText('No new fork will be created.')).toBeTruthy();
    existing.unmount();

    renderWizard(wizardClient(onSubmitForkPreview()));
    await screen.findByTestId('publication-preview');
    expect(screen.getByText('on-submit')).toBeTruthy();
    expect(screen.getByText(/public fork may be created on confirmed submit/i)).toBeTruthy();
  });

  it('blocks confirmation when the displayed preview is already expired', async () => {
    renderWizard(
      wizardClient(publicationPreview({ expiresAt: '2000-01-01T00:00:00.000Z' })),
    );
    const button = await screen.findByTestId('wizard-open-confirmation');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/expired locally/i)).toBeTruthy();
  });
});

describe('shared PublishWizard confirmation and receipt', () => {
  it('uses an accessible modal and restores focus to the opener on cancel', async () => {
    const client = wizardClient();
    renderWizard(client);
    const opener = await screen.findByTestId('wizard-open-confirmation');
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByTestId('publication-confirm');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect([
      screen.getByTestId('publication-confirm-cancel-btn'),
      screen.getByTestId('publication-confirm-ok-btn'),
    ]).toContain(document.activeElement);

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('publication-confirm')).toBeNull());
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'wizard-open-confirmation',
    );
    expect(client.submitPublication).not.toHaveBeenCalled();
  });

  it('cancel performs no submit; confirm sends the exact sealed four fields', async () => {
    const preview = onSubmitForkPreview();
    const client = wizardClient(preview);
    renderWizard(client);

    await openConfirmation();
    expect(screen.getByText(/public fork contributor\/dataset may be created first/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('publication-confirm-cancel-btn'));
    expect(client.submitPublication).not.toHaveBeenCalled();

    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    await waitFor(() => {
      expect(client.submitPublication).toHaveBeenCalledWith({
        publicationRef: preview.publicationRef,
        targetRevision: preview.target.revision,
        contentDigest: preview.contribution.contentDigest,
        confirmPublic: true,
      });
    });
  });

  it('renders the real idempotent receipt, safe link, and completes the journey', async () => {
    const receipt = publicationReceipt();
    const onPublished = vi.fn();
    renderWizard(wizardClient(publicationPreview(), receipt), ['review-a'], onPublished);
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    const link = await screen.findByTestId('publication-pr-link');
    expect(link.getAttribute('href')).toBe(receipt.prUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(receipt.commitSha)).toBeTruthy();
    expect(screen.getByText(receipt.contentDigest)).toBeTruthy();
    expect(onPublished).toHaveBeenCalledWith(receipt);
  });

  it.each([
    ['target revision', publicationReceipt({ targetRevision: 8 })],
    [
      'push repository and route',
      publicationReceipt({
        mode: 'fork',
        pushRepository: 'contributor/dataset',
      }),
    ],
    ['base branch', publicationReceipt({ baseBranch: 'release' })],
    ['record count', publicationReceipt({ recordCount: 2 })],
  ])('rejects a valid-shaped receipt with mismatched %s', async (_name, receipt) => {
    const preview = publicationPreview();
    const onPublished = vi.fn();
    renderWizard(
      wizardClient(preview, receipt),
      ['review-a'],
      onPublished,
    );
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    expect((await screen.findByTestId('wizard-error')).textContent).toContain(
      'invalid receipt',
    );
    expect(screen.getByTestId('wizard-retry-submit')).toBeTruthy();
    expect(screen.queryByTestId('publication-receipt')).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:alert(1)',
    'https://example.invalid/community/dataset/pull/42',
    'https://github.com/community/dataset/pull/99',
  ])('does not make an untrusted receipt URL clickable: %s', async (prUrl) => {
    const receipt = publicationReceipt({ prUrl });
    renderWizard(wizardClient(publicationPreview(), receipt));
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    expect(await screen.findByTestId('publication-pr-link-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('publication-pr-link')).toBeNull();
  });

  it('does not render unknown receipt authority or raw-output fields', async () => {
    const unsafeReceipt = publicationReceipt() as PublicationReceipt & {
      workspace: string;
      remoteName: string;
      token: string;
      stdout: string;
      contents: string;
    };
    unsafeReceipt.workspace = 'C:\\private\\receipt';
    unsafeReceipt.remoteName = 'secret-remote';
    unsafeReceipt.token = 'receipt-token-canary';
    unsafeReceipt.stdout = 'raw-receipt-output';
    unsafeReceipt.contents = 'exact-receipt-contents';

    const { container } = renderWizard(
      wizardClient(publicationPreview(), unsafeReceipt),
    );
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    await screen.findByTestId('publication-receipt');
    expect(container.textContent).not.toMatch(
      /C:\\private\\receipt|secret-remote|receipt-token-canary|raw-receipt-output|exact-receipt-contents/,
    );
  });
});

describe('shared PublishWizard recovery', () => {
  it.each([
    'preview_not_found',
    'preview_expired',
    'preview_stale',
    'target_changed',
  ] as const)('%s discards the preview and requires an explicit re-preview', async (code) => {
    const preview = publicationPreview();
    const error = publicationError({
      code,
      phase: 'preview',
      retryable: false,
      message: `Safe ${code}`,
    });
    const client = wizardClient(preview);
    client.submitPublication = vi.fn(async () => ({ ok: false as const, error }));
    renderWizard(client);
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    expect(await screen.findByTestId('wizard-repreview')).toBeTruthy();
    expect(client.inspectPublication).toHaveBeenCalledTimes(1);
    expect(client.previewPublication).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create new preview' }));
    await waitFor(() => expect(client.previewPublication).toHaveBeenCalledTimes(2));
    expect(client.submitPublication).toHaveBeenCalledTimes(1);
  });

  it('disables re-preview when refreshed status is no longer publishable', async () => {
    const preview = publicationPreview();
    const error = publicationError({
      code: 'target_changed',
      phase: 'preview',
      retryable: false,
    });
    const client = wizardClient(preview);
    client.submitPublication = vi.fn(async () => ({ ok: false as const, error }));
    const onRefreshStatus = vi.fn(async () => ({
      state: 'blocked' as const,
      revision: 8,
      issues: [],
    }));
    renderWizard(client, ['review-a'], vi.fn(), vi.fn(), onRefreshStatus);
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    const button = await screen.findByRole('button', { name: 'Create new preview' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/not currently ready/i)).toBeTruthy();
    expect(onRefreshStatus).toHaveBeenCalledTimes(1);
  });

  it('retries a delivery failure with the exact same sealed binding', async () => {
    const preview = publicationPreview();
    const client = wizardClient(preview);
    client.submitPublication = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: publicationError({
          code: 'github_unavailable',
          phase: 'pull_request',
          retryable: true,
        }),
      })
      .mockResolvedValueOnce({ ok: true, data: publicationReceipt() });
    renderWizard(client);
    await openConfirmation();
    fireEvent.click(screen.getByTestId('publication-confirm-ok-btn'));
    fireEvent.click(await screen.findByTestId('wizard-retry-submit'));
    await screen.findByTestId('publication-receipt');
    expect(client.submitPublication).toHaveBeenCalledTimes(2);
    expect(client.submitPublication).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        publicationRef: preview.publicationRef,
        targetRevision: preview.target.revision,
        contentDigest: preview.contribution.contentDigest,
      }),
    );
    expect(client.submitPublication).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        publicationRef: preview.publicationRef,
        targetRevision: preview.target.revision,
        contentDigest: preview.contribution.contentDigest,
      }),
    );
    expect(client.previewPublication).toHaveBeenCalledTimes(1);
  });

  it('renders count-only refusals and jumps to the attributed review/rule', async () => {
    const refusal: PublicationErrorBody = publicationError({
      code: 'precheck_refused',
      phase: 'preview',
      retryable: false,
      message: 'Publication pre-check refused the selection.',
      refusals: [
        {
          reviewId: 'review-b',
          sessionId: 'session-b',
          blockingByRule: { 'secret-rule': 3 },
        },
      ],
    });
    const client = wizardClient();
    client.previewPublication = vi.fn(async () => ({ ok: false as const, error: refusal }));
    const { onJumpToReviewIssue, container } = renderWizard(client, ['review-a', 'review-b']);
    fireEvent.click(
      await screen.findByTestId('jump-to-review-rule-review-b-secret-rule'),
    );
    expect(onJumpToReviewIssue).toHaveBeenCalledWith('review-b', 'secret-rule');
    expect(container.textContent).not.toMatch(/raw match|exact record|secret value/i);
  });

  it('offers an attributed return for missing or locked reviews', async () => {
    const client = wizardClient();
    client.previewPublication = vi.fn(async () => ({
      ok: false as const,
      error: publicationError({
        code: 'GATE_LOCKED',
        phase: 'preview',
        retryable: false,
        reviewId: 'review-b',
        message: 'A selected review is still locked.',
      }),
    }));
    const { onJumpToReviewIssue } = renderWizard(client, ['review-a', 'review-b']);
    fireEvent.click(await screen.findByTestId('jump-to-review-review-b'));
    expect(onJumpToReviewIssue).toHaveBeenCalledWith('review-b');
    expect(client.submitPublication).not.toHaveBeenCalled();
  });

  it('renders only stable error fields and keeps unknown authority details out of the DOM', async () => {
    const unsafeError = publicationError({
      code: 'workspace_unavailable',
      phase: 'workspace',
      message: 'The managed publication workspace is unavailable.',
      recovery: 'Retry after the managed workspace is available.',
    }) as PublicationErrorBody & {
      absolutePath: string;
      command: string;
      token: string;
      stderr: string;
    };
    unsafeError.absolutePath = '/private/publication-root';
    unsafeError.command = 'git push secret';
    unsafeError.token = 'error-token-canary';
    unsafeError.stderr = 'raw-error-output';
    const client = wizardClient();
    client.previewPublication = vi.fn(async () => ({
      ok: false as const,
      error: unsafeError,
    }));

    const { container } = renderWizard(client);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(container.textContent).toContain(unsafeError.message);
    expect(container.textContent).not.toMatch(
      /\/private\/publication-root|git push secret|error-token-canary|raw-error-output/,
    );
  });

  it('never renders forbidden unknown payload fields or exact file contents', async () => {
    const unsafe = publicationPreview() as PublicationPreview & {
      contents: string;
      workspace: string;
      command: string;
      token: string;
      stderr: string;
    };
    unsafe.contents = 'exact-file-contents';
    unsafe.workspace = 'C:\\Users\\private\\publication';
    unsafe.command = 'git push secret';
    unsafe.token = 'ghp_FAKE_SECRET';
    unsafe.stderr = 'raw external error';
    const { container } = renderWizard(wizardClient(unsafe));
    await screen.findByTestId('publication-preview');
    expect(container.textContent).not.toMatch(
      /exact-file-contents|C:\\Users|git push secret|ghp_FAKE_SECRET|raw external error/,
    );
  });

  it('keeps narrow-layout facts stacked and file commitments locally scrollable', async () => {
    renderWizard(wizardClient());
    const preview = await screen.findByTestId('publication-preview');
    const factGrid = preview.querySelector('dl');
    const table = preview.querySelector('table');
    expect(factGrid?.className).toContain('sm:grid-cols-2');
    expect(table?.className).toContain('min-w-[42rem]');
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
    expect(preview.className).toContain('min-w-0');
  });
});
