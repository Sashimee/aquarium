// @vitest-environment happy-dom
import type { Coral, Tank } from '@aquarium/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import type { InteractionEvents } from '../interaction/events';
import { TANK_A, TANK_B, tankFixture } from '../sync/fixtures';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE } from '../sync/state';
import { CoralSection } from './Corals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const coral = (over: Partial<Coral> = {}): Coral => ({
  key: 's1',
  assetId: 'acropora-cytherea',
  tintSeed: 1,
  parentKey: null,
  position: null,
  size: 1.8,
  minSize: 0.4,
  maxSize: 2,
  fragMinSize: 1.5,
  bleach: 0,
  ...over,
});

describe('the coral section', () => {
  let container: HTMLElement;
  let root: Root;
  let interaction: EventBus<InteractionEvents>;
  const fragCoral = vi.fn<(key: string) => Promise<{ ok: boolean; refusal: string | null }>>();

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    interaction = new EventBus<InteractionEvents>();
    fragCoral.mockReset();
    fragCoral.mockResolvedValue({ ok: true, refusal: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
  });

  async function mount(tank: Tank, busy = false) {
    const session = { fragCoral } as unknown as TankSession;
    await act(async () => {
      root.render(
        <CoralSection
          interaction={interaction}
          session={session}
          state={{ ...INITIAL_STATE, busy }}
          tank={tank}
        />,
      );
    });
  }

  const cutButtons = (): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Cut a fragment'),
    );

  const click = async (el: Element | undefined) => {
    if (!el) throw new Error('button not found');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('renders nothing for a tank without corals', async () => {
    await mount(tankFixture());
    expect(container.textContent).toBe('');
  });

  it('enables the cut for a grown, healthy colony and sends its key', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral()] }));
    const [button] = cutButtons();
    expect(button?.disabled).toBe(false);
    await click(button);
    expect(fragCoral).toHaveBeenCalledWith('s1');
  });

  it('disables the cut below fragMinSize and says why', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral({ size: 1.2 })] }));
    expect(cutButtons()[0]?.disabled).toBe(true);
    expect(container.textContent).toContain('Not grown enough yet');
  });

  it('disables the cut above the bleach limit and says why', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral({ bleach: 0.5 })] }));
    expect(cutButtons()[0]?.disabled).toBe(true);
    expect(container.textContent).toContain('Too bleached to cut');
    expect(container.textContent).toContain('bleaching, 50% bleached');
  });

  it('disables every cut while another action is running', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral()] }), true);
    expect(cutButtons()[0]?.disabled).toBe(true);
  });

  it('shows the server refusal next to the coral that was refused', async () => {
    fragCoral.mockResolvedValueOnce({
      ok: false,
      refusal: 'There is no room on the substrate near the acropora cytherea for another fragment.',
    });
    await mount(
      tankFixture({
        biome: 'reef',
        corals: [coral(), coral({ key: 's2', assetId: 'brain-coral', size: 1.2 })],
      }),
    );
    await click(cutButtons()[0]);
    const alerts = container.querySelectorAll('li [role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('no room on the substrate');
    expect(alerts[0]?.closest('li')?.textContent).toContain('acropora cytherea');
  });

  it('does not carry a refusal over to another tank with the same coral key', async () => {
    fragCoral.mockResolvedValueOnce({ ok: false, refusal: 'No room.' });
    await mount(tankFixture({ id: TANK_A, biome: 'reef', corals: [coral()] }));
    await click(cutButtons()[0]);
    expect(container.querySelectorAll('li [role="alert"]')).toHaveLength(1);
    await mount(tankFixture({ id: TANK_B, biome: 'reef', corals: [coral()] }));
    expect(container.querySelectorAll('li [role="alert"]')).toHaveLength(0);
  });

  it('warns about the lamp when it is set above what the coral takes', async () => {
    const base = tankFixture().equipment;
    await mount(
      tankFixture({
        biome: 'reef',
        corals: [coral()],
        equipment: { ...base, light: { ...base.light, tier: 3, intensity: 1 } },
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/lamp is too bright/);
  });

  it('stays quiet about the lamp when it is gentle', async () => {
    const base = tankFixture().equipment;
    await mount(
      tankFixture({
        biome: 'reef',
        corals: [coral()],
        equipment: { ...base, light: { ...base.light, tier: 1, intensity: 0.2 } },
      }),
    );
    expect(container.textContent).not.toContain('too bright');
  });

  const status = () => container.querySelector('[role="status"]');
  const pick = async (key: string | null) => {
    await act(async () => interaction.emit('coral:picked', { key }));
    await act(async () => vi.advanceTimersByTime(60));
  };
  const rows = (): HTMLLIElement[] => Array.from(container.querySelectorAll('li'));
  const currentRows = (): HTMLLIElement[] =>
    rows().filter((row) => row.getAttribute('aria-current') === 'true');

  it('marks the coral the player tapped in the tank and says so', async () => {
    await mount(
      tankFixture({
        biome: 'reef',
        corals: [coral(), coral({ key: 's2', assetId: 'brain-coral', size: 1.2 })],
      }),
    );
    expect(currentRows()).toHaveLength(0);
    await pick('s2');
    expect(currentRows()).toHaveLength(1);
    expect(currentRows()[0]?.textContent).toContain('brain coral');
    expect(status()?.textContent).toBe('Selected the brain coral.');
  });

  it('keeps the status region mounted and empties it when nothing is picked', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral()] }));
    expect(status()?.textContent).toBe('');
    await pick('s1');
    expect(status()?.textContent).toBe('Selected the acropora cytherea.');
    await pick(null);
    expect(status()?.textContent).toBe('');
  });

  it('scrolls the row into view and says it again on a repeat tap', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral(), coral({ key: 's2' })] }));
    const scroll = vi.fn();
    const row = rows()[1] as HTMLLIElement;
    row.scrollIntoView = scroll;
    await pick('s2');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(status()?.textContent).toBe('Selected the acropora cytherea 2.');
    await act(async () => interaction.emit('coral:picked', { key: 's2' }));
    expect(status()?.textContent).toBe('');
    expect(scroll).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(60));
    expect(status()?.textContent).toBe('Selected the acropora cytherea 2.');
  });

  it('announces only the last of two taps within the re-announce delay', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral(), coral({ key: 's2' })] }));
    await act(async () => interaction.emit('coral:picked', { key: 's1' }));
    await act(async () => vi.advanceTimersByTime(20));
    await act(async () => interaction.emit('coral:picked', { key: 's2' }));
    await act(async () => vi.advanceTimersByTime(40));
    expect(status()?.textContent).toBe('');
    await act(async () => vi.advanceTimersByTime(20));
    expect(status()?.textContent).toBe('Selected the acropora cytherea 2.');
  });

  it('announces nothing and leaves no timer when unmounted before the delay', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const own = document.createElement('div');
    document.body.append(own);
    const ownRoot = createRoot(own);
    try {
      await act(async () => {
        ownRoot.render(
          <CoralSection
            interaction={interaction}
            session={{ fragCoral } as unknown as TankSession}
            state={INITIAL_STATE}
            tank={tankFixture({ biome: 'reef', corals: [coral()] })}
          />,
        );
      });
      await act(async () => interaction.emit('coral:picked', { key: 's1' }));
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => ownRoot.unmount());
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTime(100));
      expect(own.textContent).toBe('');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      own.remove();
    }
  });

  it('moves the mark with each tap and clears it when the tap hits no coral', async () => {
    await mount(
      tankFixture({
        biome: 'reef',
        corals: [coral(), coral({ key: 's2', assetId: 'brain-coral' })],
      }),
    );
    await pick('s1');
    await pick('s2');
    expect(currentRows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('brain coral'),
    ]);
    await pick(null);
    expect(currentRows()).toHaveLength(0);
  });

  it("ignores a pick that is not one of this tank's corals", async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral()] }));
    await pick('gone');
    expect(currentRows()).toHaveLength(0);
    expect(status()?.textContent).toBe('');
  });

  it('does not carry the pick over to another tank', async () => {
    await mount(tankFixture({ id: TANK_A, biome: 'reef', corals: [coral()] }));
    await pick('s1');
    await mount(tankFixture({ id: TANK_B, biome: 'reef', corals: [coral()] }));
    expect(currentRows()).toHaveLength(0);
  });

  it('keeps cutting a picked coral on the same button', async () => {
    await mount(tankFixture({ biome: 'reef', corals: [coral()] }));
    await pick('s1');
    await click(cutButtons()[0]);
    expect(fragCoral).toHaveBeenCalledWith('s1');
  });
});
