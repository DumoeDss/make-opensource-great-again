// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AffirmDialog } from '../components/journey/AffirmDialog';
import { makeFinding, makeNonText, makeReport } from './_fixtures';

afterEach(cleanup);

describe('AffirmDialog', () => {
  it('aggregates the disposition summary across every session', () => {
    const reportA = makeReport([
      makeFinding({ id: 'a', disposition: 'replace' }),
      makeFinding({ id: 'b', disposition: 'delete' }),
    ]);
    const reportB = makeReport(
      [makeFinding({ id: 'c', disposition: 'replace' }), makeFinding({ id: 'd', disposition: 'allow' })],
      [makeNonText({ messageUuid: 'm1', disposition: 'keep' })],
    );
    const { getByTestId } = render(
      <AffirmDialog open onOpenChange={vi.fn()} reports={[reportA, reportB]} onConfirm={vi.fn()} />,
    );

    expect(getByTestId('summary-sessions').textContent).toBe('2');
    // replace: 2 (A) ... wait A has 1 replace + 1 delete, B has 1 replace + 1 allow.
    expect(getByTestId('summary-dispositions').textContent).toContain('替换 2');
    expect(getByTestId('summary-dispositions').textContent).toContain('删除 1');
    expect(getByTestId('summary-dispositions').textContent).toContain('放行 1');
    expect(getByTestId('summary-nontext').textContent).toContain('保留 1');
  });

  it('fires onConfirm and closes when confirmed', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    const { getByTestId } = render(
      <AffirmDialog open onOpenChange={onOpenChange} reports={[makeReport([])]} onConfirm={onConfirm} />,
    );
    fireEvent.click(getByTestId('affirm-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
