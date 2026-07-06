// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FindingsTable } from '../components/FindingsTable';
import { makeFinding } from './_fixtures';

afterEach(cleanup);

describe('FindingsTable', () => {
  it('calls onDisposition with the chosen value for a secret finding', () => {
    const onDisposition = vi.fn();
    const finding = makeFinding({ id: 'fx' });
    const { getByTestId } = render(
      <FindingsTable
        findings={[finding]}
        onDisposition={onDisposition}
        onBatchByRule={() => {}}
      />,
    );
    // Only the redacted preview is shown, never a raw secret.
    expect(getByTestId('finding-row-fx').textContent).toContain('AK…34');
    fireEvent.click(getByTestId('disp-fx-replace'));
    expect(onDisposition).toHaveBeenCalledWith('fx', 'replace');
  });

  it('renders a meta finding with an acknowledge (allow) affordance', () => {
    const onDisposition = vi.fn();
    const meta = makeFinding({
      id: 'meta1',
      ruleId: 'ruleset-compile-error',
      location: { scope: 'session', field: 'rulesetMeta', span: { start: 0, end: 0 } },
      matchPreview: 'rule failed to compile',
    });
    const { getByTestId, queryByTestId } = render(
      <FindingsTable findings={[meta]} onDisposition={onDisposition} onBatchByRule={() => {}} />,
    );
    // No replace/delete for a meta finding — only acknowledge.
    expect(queryByTestId('disp-meta1-replace')).toBeNull();
    fireEvent.click(getByTestId('ack-meta1'));
    expect(onDisposition).toHaveBeenCalledWith('meta1', 'allow');
  });

  it('fires batch-by-rule for a rule group', () => {
    const onBatchByRule = vi.fn();
    const { getByTestId } = render(
      <FindingsTable
        findings={[makeFinding({ id: 'a' }), makeFinding({ id: 'b' })]}
        onDisposition={() => {}}
        onBatchByRule={onBatchByRule}
      />,
    );
    fireEvent.click(getByTestId('batch-rule-aws-access-token'));
    expect(onBatchByRule).toHaveBeenCalledWith('aws-access-token', 'replace');
  });
});
