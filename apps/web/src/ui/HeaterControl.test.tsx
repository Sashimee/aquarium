// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tankFixture } from '../sync/fixtures';
import type { SessionState, TankSession } from '../sync/session';
import { HeaterControl, heaterMode } from './HeaterControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tankWith(tier: number, owned: number) {
  const base = tankFixture();
  return { ...base, equipment: { ...base.equipment, heater: { tier } }, heaterOwnedTier: owned };
}

describe('heaterMode', () => {
  it('tells installed, removed and never-owned apart', () => {
    expect(heaterMode(tankWith(1, 1))).toBe('installed');
    expect(heaterMode(tankWith(0, 2))).toBe('removed');
    expect(heaterMode(tankWith(0, 0))).toBe('none');
  });
});

describe('the heater control', () => {
  let container: HTMLElement;
  let root: Root;
  const removeHeater = vi.fn();
  const reinstallHeater = vi.fn();

  beforeEach(() => {
    removeHeater.mockReset();
    reinstallHeater.mockReset();
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
        <HeaterControl
          session={{ removeHeater, reinstallHeater } as unknown as TankSession}
          state={{ busy } as SessionState}
          tank={tank}
        />,
      ),
    );
  const action = (name: string) =>
    container.querySelector<HTMLButtonElement>(`[data-heater-action="${name}"]`);

  it('asks before removing, naming the room temperature, and only then calls the session', () => {
    show(tankWith(1, 1));
    act(() => action('remove')?.click());
    expect(removeHeater).not.toHaveBeenCalled();
    expect(container.textContent).toContain('cools to room temperature');
    act(() => action('confirm-remove')?.click());
    expect(removeHeater).toHaveBeenCalledTimes(1);
  });

  it('backs out of the confirmation without calling the session', () => {
    show(tankWith(1, 1));
    act(() => action('remove')?.click());
    act(() =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Keep it')?.click(),
    );
    expect(action('confirm-remove')).toBeNull();
    expect(removeHeater).not.toHaveBeenCalled();
  });

  it('offers a free reinstall only when removed and owned', () => {
    show(tankWith(0, 2));
    expect(action('remove')).toBeNull();
    expect(action('reinstall')?.textContent).toContain('free');
    act(() => action('reinstall')?.click());
    expect(reinstallHeater).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a tank that never had a heater', () => {
    show(tankWith(0, 0));
    expect(container.querySelector('[data-testid="heater-control"]')).toBeNull();
  });

  it('disables the actions while a request is in flight', () => {
    show(tankWith(1, 1), true);
    expect(action('remove')?.disabled).toBe(true);
    show(tankWith(0, 1), true);
    expect(action('reinstall')?.disabled).toBe(true);
  });
});
