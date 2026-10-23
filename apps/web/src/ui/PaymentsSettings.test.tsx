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

  const box = () => container.querySelector<HTMLInputElement>('input[type=checkbox]');
  const passwordField = () => container.querySelector<HTMLInputElement>('input[type=password]');
  const type = async (el: HTMLInputElement | null, value: string) => {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(el, value);
      el?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  };

  it('asks for the password on a tick and confirms with it', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockResolvedValue(state({ adultConfirmed: true }));
    await show();
    expect(passwordField()).toBeNull();
    await click(box());
    expect(api.setAdultConfirmation).not.toHaveBeenCalled();
    await type(passwordField(), 'hunter2hunter2');
    await submit();
    expect(api.setAdultConfirmation).toHaveBeenCalledWith(true, 'hunter2hunter2');
    expect(box()?.checked).toBe(true);
    expect(passwordField()).toBeNull();
  });

  it('lets a passkey-only account confirm with the field empty', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockResolvedValue(state({ adultConfirmed: true }));
    await show();
    await click(box());
    await submit();
    expect(api.setAdultConfirmation).toHaveBeenCalledWith(true, undefined);
  });

  it('says the password is wrong on a 403 when one was sent', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockRejectedValue(new ApiRequestError(403, 'forbidden', 'x'));
    await show();
    await click(box());
    await type(passwordField(), 'nope');
    await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('password is not right');
    expect(passwordField()).not.toBeNull();
  });

  it('tells a passkey-only account to sign in again on a 403', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockRejectedValue(new ApiRequestError(403, 'forbidden', 'x'));
    await show();
    await click(box());
    await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Sign in again');
  });

  it('shows the wait on a 429', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.setAdultConfirmation.mockRejectedValue(
      new ApiRequestError(429, 'rate_limited', 'x', {}, 30),
    );
    await show();
    await click(box());
    await type(passwordField(), 'pw');
    await submit();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('30 s');
  });

  it('withdraws without a password', async () => {
    api.paymentsState.mockResolvedValue(state({ adultConfirmed: true }));
    api.setAdultConfirmation.mockResolvedValue(state());
    await show();
    await click(box());
    expect(api.setAdultConfirmation).toHaveBeenCalledWith(false);
    expect(passwordField()).toBeNull();
  });

  it('closes the password field when the tick is withdrawn before confirming', async () => {
    api.paymentsState.mockResolvedValue(state());
    await show();
    await click(box());
    await click(box());
    expect(passwordField()).toBeNull();
    expect(api.setAdultConfirmation).not.toHaveBeenCalled();
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
