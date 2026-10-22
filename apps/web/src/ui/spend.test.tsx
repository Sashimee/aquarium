// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsState } from '@aquarium/shared';
import type { TankSession } from '../sync/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = { paymentsState: vi.fn(), paymentsPacks: vi.fn() };
vi.mock('./context', () => ({ useOptionalApi: () => api }));

const { OpenShopContext, PEARL_PACKS_ID, useSpend } = await import('./spend');

const session = {
  getState: () => ({ balance: 10, pearlsRefused: false }),
  refreshWallet: vi.fn().mockResolvedValue(undefined),
  clearMessages: vi.fn(),
} as unknown as TankSession;

function Probe() {
  const { spend, notice } = useSpend(session, 10);
  return (
    <>
      <button
        type="button"
        id="buy"
        onClick={() =>
          void spend({ label: 'a lamp', price: 100, confirm: false, go: async () => true })
        }
      >
        Buy
      </button>
      {notice}
    </>
  );
}

const payments = (over: Partial<PaymentsState> = {}): PaymentsState => ({
  payments: 'enabled',
  adultConfirmed: true,
  subscription: null,
  ...over,
});

describe('the not enough Pearls note', () => {
  let container: HTMLElement;
  let root: Root;
  const openShop = vi.fn();

  beforeEach(() => {
    api.paymentsState.mockReset();
    api.paymentsPacks.mockReset();
    openShop.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const shortOfPearls = async () => {
    await act(async () => {
      root.render(
        <OpenShopContext.Provider value={openShop}>
          <Probe />
        </OpenShopContext.Provider>,
      );
    });
    await act(async () => {
      container.querySelector('#buy')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 5; i += 1) await act(async () => {});
  };

  it('links to the Pearl packs when payments are on', async () => {
    api.paymentsState.mockResolvedValue(payments());
    api.paymentsPacks.mockResolvedValue({
      packs: [{ id: 'pearls-550', priceCents: 499, pearls: 550, webAvailable: true }],
      subscription: { id: 'club', priceCents: 499, interval: 'month', pearlsPerDay: 20 },
    });
    await shortOfPearls();
    expect(container.textContent).not.toContain('not on sale');
    const link = container.querySelector<HTMLAnchorElement>(`a[href="#${PEARL_PACKS_ID}"]`);
    expect(link?.textContent).toBe('See the Pearl packs');
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(openShop).toHaveBeenCalledOnce();
  });

  it('says calmly that packs are unavailable when payments are off', async () => {
    api.paymentsState.mockResolvedValue(payments({ payments: 'disabled' }));
    await shortOfPearls();
    expect(container.textContent).toContain('Pearl packs are not available right now.');
    expect(container.textContent).not.toContain('not on sale');
    expect(container.querySelector('a')).toBeNull();
  });
});
