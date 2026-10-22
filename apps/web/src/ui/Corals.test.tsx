// @vitest-environment happy-dom
import type { Coral, Tank } from '@aquarium/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tankFixture } from '../sync/fixtures';
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
  const fragCoral = vi.fn<(key: string) => Promise<{ ok: boolean; refusal: string | null }>>();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    fragCoral.mockReset();
    fragCoral.mockResolvedValue({ ok: true, refusal: null });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function mount(tank: Tank, busy = false) {
    const session = { fragCoral } as unknown as TankSession;
    await act(async () => {
      root.render(
        <CoralSection session={session} state={{ ...INITIAL_STATE, busy }} tank={tank} />,
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
});
