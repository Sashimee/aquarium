// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsState } from '@aquarium/shared';
import type { TankSession } from '../sync/session';
import { ApiRequestError } from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = {
  paymentsState: vi.fn(),
  paymentsPacks: vi.fn(),
  checkoutPack: vi.fn(),
  checkoutSubscription: vi.fn(),
  cancelSubscription: vi.fn(),
  setAdultConfirmation: vi.fn(),
};
vi.mock('./context', () => ({ useApi: () => api }));

const goToCheckout = vi.fn();
vi.mock('../sync/payments', async (original) => ({
  ...(await original<typeof import('../sync/payments')>()),
  goToCheckout: (...args: unknown[]) => goToCheckout(...args),
}));

const { PaymentsShop } = await import('./PaymentsShop');

const offer = { id: 'club', priceCents: 499, interval: 'month', pearlsPerDay: 20 };
const packs = [
  { id: 'pearls-550', priceCents: 499, pearls: 550, webAvailable: true },
  { id: 'pearls-1200', priceCents: 999, pearls: 1200, webAvailable: true },
];
const state = (over: Partial<PaymentsState> = {}): PaymentsState => ({
  payments: 'enabled',
  adultConfirmed: true,
  subscription: null,
  ...over,
});
const running: PaymentsState = state({
  subscription: {
    status: 'active',
    paidUntil: '2026-11-20T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  },
});

describe('the Pearl packs section', () => {
  let container: HTMLElement;
  let root: Root;
  const session = {
    refreshWallet: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(() => ({ balance: 100 })),
  } as unknown as TankSession;

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    goToCheckout.mockReset();
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const show = async () => {
    await act(async () => {
      root.render(<PaymentsShop session={session} balance={100} />);
    });
  };
  const text = () => container.textContent ?? '';
  const button = (name: RegExp) =>
    [...container.querySelectorAll('button')].find((b) =>
      name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
    );
  const click = async (el: Element | undefined) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const ready = (s = state()) => {
    api.paymentsState.mockResolvedValue(s);
    api.paymentsPacks.mockResolvedValue({ packs, subscription: offer });
  };
  const consent = async () => {
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    await click(boxes[1]);
  };
  const alertText = () => container.querySelector('[role=alert]')?.textContent;

  it('lists the server packs with their prices', async () => {
    ready();
    await show();
    expect(text()).toContain('550 Pearls');
    expect(text()).toContain('€4.99');
    expect(text()).toContain('€9.99');
    expect(text()).toContain('20 Pearls every day for €4.99 a month');
  });

  it('shows one calm note and no buy buttons when payments are off', async () => {
    api.paymentsState.mockResolvedValue(state({ payments: 'disabled' }));
    await show();
    expect(text()).toContain('Purchases are not available yet');
    expect(container.querySelector('button')).toBeNull();
    expect(alertText()).toBeUndefined();
  });

  it('treats a 503 on the packs as off', async () => {
    api.paymentsState.mockResolvedValue(state());
    api.paymentsPacks.mockRejectedValue(new ApiRequestError(503, 'payments_disabled', 'off'));
    await show();
    expect(text()).toContain('Purchases are not available yet');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps buying disabled until the consent box is ticked', async () => {
    ready();
    await show();
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(true);
    await consent();
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends the chosen pack with consent', async () => {
    ready();
    api.checkoutPack.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    await show();
    await consent();
    await click(button(/Buy 1,?200/));
    expect(goToCheckout).toHaveBeenCalledWith({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(api.checkoutPack).toHaveBeenCalledWith('pearls-1200', {
      immediateDelivery: true,
      withdrawalWaiver: true,
    });
  });

  it('shows the server refusal and stays on the page', async () => {
    ready();
    api.checkoutPack.mockRejectedValue(
      new ApiRequestError(403, 'adult_confirmation_required', 'x'),
    );
    await show();
    await consent();
    await click(button(/Buy 550/));
    expect(alertText()).toContain('adult');
  });

  it('shows paid-until and cancels in one click', async () => {
    ready(running);
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
    expect(button(/Join/)).toBeUndefined();
    await click(button(/Cancel membership/));
    expect(api.cancelSubscription).toHaveBeenCalledOnce();
    expect(text()).toContain('cancelled and runs until 20 November 2026');
    expect(button(/Cancel membership/)).toBeUndefined();
  });

  it('shows a 409 on cancel and reloads the real state', async () => {
    ready(running);
    api.cancelSubscription.mockRejectedValue(
      new ApiRequestError(409, 'conflict', 'You have no active subscription.'),
    );
    await show();
    ready(state());
    await click(button(/Cancel membership/));
    expect(alertText()).toBe('You have no active subscription.');
    expect(button(/Join/)).toBeDefined();
  });

  it('shows 503 on cancel as the not-available note', async () => {
    ready(running);
    api.cancelSubscription.mockRejectedValue(new ApiRequestError(503, 'payments_disabled', 'off'));
    await show();
    await click(button(/Cancel membership/));
    expect(alertText()).toBe('Purchases are not available yet.');
  });

  it('offers to join when there is no subscription', async () => {
    ready();
    api.checkoutSubscription.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_2' });
    await show();
    await consent();
    await click(button(/Join the Aquarist Club/));
    expect(api.checkoutSubscription).toHaveBeenCalledWith({
      immediateDelivery: true,
      withdrawalWaiver: true,
    });
    expect(goToCheckout).toHaveBeenCalledWith({ url: 'https://checkout.stripe.com/c/pay/cs_2' });
  });

  it('reports a cancelled checkout without an error and cleans the address', async () => {
    ready();
    window.history.replaceState(null, '', '/?payment=cancelled');
    await show();
    expect(text()).toContain('Checkout was cancelled. Nothing was charged.');
    expect(alertText()).toBeUndefined();
    expect(window.location.search).toBe('');
  });
});
