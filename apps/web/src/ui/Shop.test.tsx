// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speciesFixture, tankFixture } from '../sync/fixtures';
import { INITIAL_STATE } from '../sync/state';
import type { TankSession } from '../sync/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./context', () => ({ useApi: () => ({}) }));
vi.mock('./PaymentsShop', () => ({ PaymentsShop: () => null }));
vi.mock('./spend', () => ({
  useSpend: () => ({
    spend: async ({ go }: { go: () => Promise<boolean> }) => {
      await go();
    },
    notice: null,
  }),
}));

const { ShopSections } = await import('./Shop');

const discus = speciesFixture({ id: 'discus', commonName: 'Discus', warmWater: true });
const state = { ...INITIAL_STATE, balance: 100000, species: [discus] };

describe('the shop heater warning', () => {
  let container: HTMLElement;
  let root: Root;
  const session = {
    refreshWallet: vi.fn().mockResolvedValue(undefined),
    buy: vi.fn().mockResolvedValue(true),
  };

  beforeEach(() => {
    session.buy.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = async (heaterTier: number) => {
    const base = tankFixture();
    const tank = { ...base, equipment: { ...base.equipment, heater: { tier: heaterTier } } };
    await act(async () =>
      root.render(
        <ShopSections session={session as unknown as TankSession} state={state} tank={tank} />,
      ),
    );
  };
  const addButton = () =>
    [...container.querySelectorAll('ul.shop button')].find((b) =>
      /^(Add|Add anyway)$/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('asks first for a warm-water fish in a tank with no heater, then adds on confirmation', async () => {
    await show(0);
    await click(addButton());
    expect(session.buy).not.toHaveBeenCalled();
    expect(container.querySelector('.warning')?.textContent).toContain('has no heater');
    expect(addButton().textContent).toBe('Add anyway');
    await click(addButton());
    expect(session.buy).toHaveBeenCalledTimes(1);
  });

  it('adds straight away when the tank has a heater', async () => {
    await show(1);
    await click(addButton());
    expect(container.querySelector('.warning')).toBeNull();
    expect(session.buy).toHaveBeenCalledTimes(1);
  });
});
