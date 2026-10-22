// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsState } from '@aquarium/shared';
import { ApiRequestError } from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  paymentsState: vi.fn(),
  setAdultConfirmation: vi.fn(),
  cancelSubscription: vi.fn(),
};
vi.mock('./context', () => ({ useApi: () => api }));

const { PaymentsSettings } = await import('./PaymentsSettings');

const state = (over: Partial<PaymentsState> = {}): PaymentsState => ({
  payments: 'enabled',
  adultConfirmed: false,
  subscription: null,
  ...over,
});
const running = state({
  adultConfirmed: true,
  subscription: {
    status: 'active',
    paidUntil: '2026-11-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  },
});

describe('purchase settings', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = async () => {
    await act(async () => root.render(<PaymentsSettings />));
  };
  const text = () => container.textContent ?? '';
  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const cancelButton = () =>
    [...container.querySelectorAll('button')].find((b) => /Cancel membership/.test(b.textContent));

  it('renders nothing when payments are off', async () => {
    api.paymentsState.mockResolvedValue(state({ payments: 'disabled' }));
    await show();
    expect(container.innerHTML).toBe('');
  });

  it('confirms the adult on a tick and stores what the server answers', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockResolvedValue(state({ adultConfirmed: true }));
    await show();
    const box = container.querySelector<HTMLInputElement>('input[type=checkbox]');
    expect(box?.checked).toBe(false);
    await click(box);
    expect(api.setAdultConfirmation).toHaveBeenCalledWith(true);
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true);
  });

  it('shows paid-until and cancels in one click', async () => {
    api.paymentsState.mockResolvedValue(running);
    api.cancelSubscription.mockResolvedValue({
      ...running,
      subscription: {
        status: 'active',
        paidUntil: '2026-11-20T00:00:00.000Z',
        cancelAtPeriodEnd: true,
      },
    });
    await show();
    expect(text()).toContain('Paid until 20 November 2026');
    await click(cancelButton());
    expect(api.cancelSubscription).toHaveBeenCalledOnce();
    expect(text()).toContain('cancelled and runs until 20 November 2026');
    expect(text()).toContain('Your membership is cancelled.');
    expect(cancelButton()).toBeUndefined();
  });

  it('shows a 409 on cancel and reloads the real state', async () => {
    api.paymentsState.mockResolvedValue(running);
    api.cancelSubscription.mockRejectedValue(
      new ApiRequestError(409, 'conflict', 'You have no active subscription.'),
    );
    await show();
    api.paymentsState.mockResolvedValue(state({ adultConfirmed: true }));
    await click(cancelButton());
    expect(container.querySelector('[role=alert]')?.textContent).toBe(
      'You have no active subscription.',
    );
    expect(cancelButton()).toBeUndefined();
  });

  it('says so when the state cannot be loaded', async () => {
    api.paymentsState.mockRejectedValue(new ApiRequestError(0, 'network', 'x'));
    await show();
    expect(text()).toContain('could not be loaded');
  });
});
