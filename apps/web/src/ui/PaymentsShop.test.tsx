// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsState } from '@aquarium/shared';
import { paymentNotice } from '../sync/payments';
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
    paymentNotice.set(null);
    sessionStorage.clear();
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
    await click(boxes[0]);
    await click(boxes[1]);
  };
  const box = (index: number) =>
    container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[index] as HTMLInputElement;
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

  it('keeps buying disabled while only one of the two consents is ticked', async () => {
    ready();
    await show();
    await click(box(0));
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(true);
    expect(box(0).checked).toBe(true);
    await click(box(0));
    await click(box(1));
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(true);
    expect((button(/Join/) as HTMLButtonElement).disabled).toBe(true);
    await click(box(0));
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(false);
    expect((button(/Join/) as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts with both consent boxes unticked and no adult box in the shop', async () => {
    ready();
    await show();
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
    expect(box(0).checked).toBe(false);
    expect(box(1).checked).toBe(false);
  });

  it('sends the user to the settings and blocks buying until an adult has confirmed', async () => {
    ready(state({ adultConfirmed: false }));
    await show();
    await consent();
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
    expect((button(/Buy 550/) as HTMLButtonElement).disabled).toBe(true);
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

  it('leaves cancelling to the settings and does not offer a second join', async () => {
    ready(running);
    await show();
    expect(button(/Join/)).toBeUndefined();
    expect(button(/Cancel membership/)).toBeUndefined();
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull();
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

  it('shows the cancelled notice once, not on every later shop open', async () => {
    ready();
    window.history.replaceState(null, '', '/?payment=cancelled');
    await show();
    expect(text()).toContain('Checkout was cancelled.');
    act(() => root.unmount());
    root = createRoot(container);
    await show();
    expect(text()).not.toContain('Checkout was cancelled.');
  });

  describe('returning from Checkout with ?payment=success', () => {
    const back = async (wallet: () => number | null, server = state()) => {
      ready(server);
      window.history.replaceState(null, '', '/?payment=success');
      vi.mocked(session.getState).mockImplementation(() => ({ balance: wallet() }) as never);
      await show();
      for (let i = 0; i < 10; i += 1) await act(async () => {});
    };

    it('confirms a pack only once the balance has risen above the saved baseline', async () => {
      sessionStorage.setItem(
        'aquarium.payment-pending',
        JSON.stringify({ kind: 'pack', balance: 100 }),
      );
      await back(() => 650);
      expect(text()).toContain('Your Pearls have arrived.');
      expect(sessionStorage.getItem('aquarium.payment-pending')).toBeNull();
      expect(window.location.search).toBe('');
    });

    it('does not claim success while the balance has not moved', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        sessionStorage.setItem(
          'aquarium.payment-pending',
          JSON.stringify({ kind: 'pack', balance: 100 }),
        );
        await back(() => 100);
        expect(text()).not.toContain('Your Pearls have arrived.');
        expect(text()).toContain('Waiting for the payment');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays neutral when the baseline is unknown', async () => {
      sessionStorage.setItem(
        'aquarium.payment-pending',
        JSON.stringify({ kind: 'pack', balance: null }),
      );
      await back(() => 650);
      expect(text()).not.toContain('have arrived');
      expect(text()).toContain('Stripe has received your payment');
    });

    it('stays neutral when nothing was saved, for a pack or a membership alike', async () => {
      await back(() => 650);
      expect(text()).not.toContain('have arrived');
      expect(text()).not.toContain('now an Aquarist Club member');
      expect(text()).toContain('Stripe has received your payment');
    });

    it('stays neutral when the saved record is not what this code wrote', async () => {
      sessionStorage.setItem('aquarium.payment-pending', '{"kind":"gift"}');
      await back(() => 650);
      expect(text()).toContain('Stripe has received your payment');
    });

    it('confirms a membership when the server now reports it as running', async () => {
      sessionStorage.setItem('aquarium.payment-pending', JSON.stringify({ kind: 'subscription' }));
      await back(() => 0, running);
      expect(text()).toContain('now an Aquarist Club member');
    });

    it('does not repeat the confirmation when the shop is closed and opened again', async () => {
      sessionStorage.setItem(
        'aquarium.payment-pending',
        JSON.stringify({ kind: 'pack', balance: 100 }),
      );
      await back(() => 650);
      act(() => root.unmount());
      root = createRoot(container);
      ready();
      await show();
      expect(text()).not.toContain('Your Pearls have arrived.');
    });

    it('survives a wallet refresh that throws something unexpected', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        sessionStorage.setItem(
          'aquarium.payment-pending',
          JSON.stringify({ kind: 'pack', balance: 100 }),
        );
        vi.mocked(session.refreshWallet).mockRejectedValueOnce(new TypeError('boom'));
        await back(() => 650);
        expect(alertText()).toBeUndefined();
        expect(text()).not.toContain('have arrived');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
