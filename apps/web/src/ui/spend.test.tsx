// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentsState } from '@aquarium/shared';
import type { TankSession } from '../sync/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = { paymentsState: vi.fn(), paymentsPacks: vi.fn() };
vi.mock('./context', () => ({ useApi: () => api }));

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

  const enable = () => {
    api.paymentsState.mockResolvedValue(payments());
    api.paymentsPacks.mockResolvedValue({
      packs: [{ id: 'pearls-550', priceCents: 499, pearls: 550, webAvailable: true }],
      subscription: { id: 'club', priceCents: 499, interval: 'month', pearlsPerDay: 20 },
    });
  };
  const followLink = async () => {
    const link = container.querySelector<HTMLAnchorElement>(`a[href="#${PEARL_PACKS_ID}"]`);
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  const frames = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }
  };
  const mountSection = () => {
    const section = document.createElement('section');
    section.id = PEARL_PACKS_ID;
    const heading = document.createElement('h3');
    heading.tabIndex = -1;
    section.append(heading);
    section.scrollIntoView = vi.fn();
    document.body.append(section);
    return { section, heading };
  };

  it('scrolls to and focuses the packs once the lazy Shop panel has mounted them', async () => {
    enable();
    await shortOfPearls();
    await followLink();
    await frames(3);
    const { section, heading } = mountSection();
    await frames(2);
    expect(section.scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(heading);
    section.remove();
  });

  it('stops waiting for the packs when the note goes away', async () => {
    enable();
    await shortOfPearls();
    await followLink();
    act(() => root.unmount());
    root = createRoot(container);
    const { section, heading } = mountSection();
    await frames(3);
    expect(document.activeElement).not.toBe(heading);
    section.remove();
  });

  it('asks once whether payments are on, however many notes follow', async () => {
    enable();
    await shortOfPearls();
    await act(async () => {
      container.querySelector('#buy')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    for (let i = 0; i < 5; i += 1) await act(async () => {});
    expect(api.paymentsState).toHaveBeenCalledTimes(1);
  });

  it('says calmly that packs are unavailable when payments are off', async () => {
    api.paymentsState.mockResolvedValue(payments({ payments: 'disabled' }));
    await shortOfPearls();
    expect(container.textContent).toContain('Pearl packs are not available right now.');
    expect(container.textContent).not.toContain('not on sale');
    expect(container.querySelector('a')).toBeNull();
  });
});
