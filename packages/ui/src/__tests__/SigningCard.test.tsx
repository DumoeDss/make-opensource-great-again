// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SigningCard } from '../components/journey/SigningCard';
import { Stepper } from '../components/shell/Stepper';
import { makeFinding, makeReport } from './_fixtures';

afterEach(cleanup);

describe('SigningCard', () => {
  it('is not actionable while the gate is locked', () => {
    const report = makeReport([makeFinding({ disposition: 'pending' })]);
    const onSign = vi.fn();
    const { getByTestId } = render(<SigningCard report={report} onSign={onSign} />);

    expect((getByTestId('sign-checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId('sign-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables signing only once cleared AND affirmed', () => {
    const report = makeReport([makeFinding({ disposition: 'replace' })]);
    const onSign = vi.fn();
    const { getByTestId } = render(<SigningCard report={report} onSign={onSign} />);

    // Cleared but unaffirmed → sign still disabled.
    const btn = getByTestId('sign-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.click(getByTestId('sign-checkbox'));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onSign).toHaveBeenCalledOnce();
  });
});

describe('Stepper lock badge', () => {
  it('shows the remaining count while locked', () => {
    const { getByTestId } = render(
      <Stepper current={2} cleared={false} signed={false} completed={false} pending={3} />,
    );
    expect(getByTestId('lock-badge').textContent).toContain('还差 3 项解锁');
  });

  it('transitions cleared → signed → completed', () => {
    const cleared = render(
      <Stepper current={3} cleared signed={false} completed={false} pending={0} />,
    );
    expect(cleared.getByTestId('lock-badge').textContent).toContain('已解锁');
    cleanup();

    const signed = render(<Stepper current={4} cleared signed completed={false} pending={0} />);
    expect(signed.getByTestId('lock-badge').textContent).toContain('已签署');
    cleanup();

    const done = render(<Stepper current={4} cleared signed completed pending={0} />);
    expect(done.getByTestId('lock-badge').textContent).toContain('已完成');
  });
});
