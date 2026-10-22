// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState, TankSession } from '../sync/session';
import { tankFixture } from '../sync/fixtures';
import { Co2Control } from './Co2Control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tankWith(tier: number, owned: number, biome: 'freshwater' | 'blackwater' = 'freshwater') {
  const base = tankFixture({ biome });
  return {
    ...base,
    equipment: { ...base.equipment, co2: { tier } },
    co2OwnedTier: owned,
  };
}

describe('the CO2 control', () => {
  let container: HTMLElement;
  let root: Root;
  const setCo2 = vi.fn();
  const onShop = vi.fn();

  beforeEach(() => {
    setCo2.mockReset();
    onShop.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (tank: ReturnType<typeof tankWith>, busy = false) =>
    act(() =>
      root.render(
        <Co2Control
          session={{ setCo2 } as unknown as TankSession}
          state={{ busy } as SessionState}
          tank={tank}
          onShop={onShop}
        />,
      ),
    );
  const button = (tier: number) =>
    container.querySelector<HTMLButtonElement>(`[data-co2-tier="${tier}"]`);

  it('switches to a lower owned tier and to Off through the session', () => {
    show(tankWith(2, 2));
    act(() => button(1)?.click());
    act(() => button(0)?.click());
    expect(setCo2.mock.calls).toEqual([[1], [0]]);
  });

  it('marks the running tier pressed and does not resend it', () => {
    show(tankWith(2, 2));
    expect(button(2)?.getAttribute('aria-pressed')).toBe('true');
    act(() => button(2)?.click());
    expect(setCo2).not.toHaveBeenCalled();
  });

  it('sends a tier above the owned one to the shop instead of picking it', () => {
    show(tankWith(1, 1));
    expect(button(2)?.getAttribute('data-co2-state')).toBe('shop');
    act(() => button(2)?.click());
    expect(onShop).toHaveBeenCalledTimes(1);
    expect(setCo2).not.toHaveBeenCalled();
  });

  it('greys out tiers the biome refuses but lets a running system be turned off', () => {
    show(tankWith(1, 1, 'blackwater'));
    expect(button(0)?.disabled).toBe(false);
    expect(button(2)?.disabled).toBe(true);
    act(() => button(2)?.click());
    act(() => button(0)?.click());
    expect(setCo2.mock.calls).toEqual([[0]]);
  });

  it('is absent for a blackwater tank that never had CO2', () => {
    show(tankWith(0, 0, 'blackwater'));
    expect(container.querySelector('[data-testid="co2-control"]')).toBeNull();
  });

  it('disables the choices while a request is in flight', () => {
    show(tankWith(2, 2), true);
    expect(button(1)?.disabled).toBe(true);
    expect(button(0)?.disabled).toBe(true);
  });
});
