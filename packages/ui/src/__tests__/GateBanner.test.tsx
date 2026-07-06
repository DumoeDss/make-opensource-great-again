// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GateBanner } from '../components/GateBanner';
import { makeFinding, makeReport } from './_fixtures';

afterEach(cleanup);

describe('GateBanner', () => {
  it('locks and disables export from a report with a pending blocking finding', () => {
    const report = makeReport([makeFinding({ disposition: 'pending' })]);
    const { getByTestId } = render(
      <GateBanner gate={report.gate} signed={false} onSignedChange={() => {}} onExport={() => {}} />,
    );
    expect(getByTestId('gate-status').textContent).toContain('locked');
    expect((getByTestId('export-button') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('sign-checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(getByTestId('blocking-pending').textContent).toBe('1');
  });

  it('enables export only when unlocked AND signed', () => {
    const report = makeReport([makeFinding({ disposition: 'replace' })]);
    const onExport = vi.fn();

    const unsigned = render(
      <GateBanner gate={report.gate} signed={false} onSignedChange={() => {}} onExport={onExport} />,
    );
    expect((unsigned.getByTestId('export-button') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const signed = render(
      <GateBanner gate={report.gate} signed onSignedChange={() => {}} onExport={onExport} />,
    );
    const btn = signed.getByTestId('export-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onExport).toHaveBeenCalledOnce();
  });
});
