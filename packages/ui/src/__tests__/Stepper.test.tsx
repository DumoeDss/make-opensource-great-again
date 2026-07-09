// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Stepper } from '../components/shell/Stepper';

afterEach(cleanup);

describe('Stepper (3-step lock badge)', () => {
  it('shows the remaining count and gates 选择出口 while locked', () => {
    const { getByTestId } = render(
      <Stepper current={2} cleared={false} completed={false} pending={3} maxEnterable={2} onNavigate={vi.fn()} />,
    );
    expect(getByTestId('lock-badge').textContent).toContain('还差 3 项解锁');
    expect((getByTestId('goto-step-3') as HTMLButtonElement).disabled).toBe(true);
  });

  it('unlocks 选择出口 once cleared', () => {
    const onNavigate = vi.fn();
    const { getByTestId } = render(
      <Stepper current={2} cleared completed={false} pending={0} maxEnterable={3} onNavigate={onNavigate} />,
    );
    expect(getByTestId('lock-badge').textContent).toContain('已解锁');
    const goExit = getByTestId('goto-step-3') as HTMLButtonElement;
    expect(goExit.disabled).toBe(false);
    fireEvent.click(goExit);
    expect(onNavigate).toHaveBeenCalledWith(3);
  });

  it('shows 已完成 when completed', () => {
    const { getByTestId } = render(
      <Stepper current={3} cleared completed pending={0} maxEnterable={3} onNavigate={vi.fn()} />,
    );
    expect(getByTestId('lock-badge').textContent).toContain('已完成');
  });
});
