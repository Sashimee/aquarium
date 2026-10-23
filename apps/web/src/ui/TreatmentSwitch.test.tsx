// @vitest-environment happy-dom
import type { Medicine } from '@aquarium/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FISH_1, FISH_2, fishFixture, speciesFixture, tankFixture } from '../sync/fixtures';
import type { TankSession } from '../sync/session';
import { INITIAL_STATE } from '../sync/state';
import { Treatment } from './Treatment';
import type { ApiClient } from './api';

vi.mock('./context', async (original) => ({
  ...(await original<typeof import('./context')>()),
  useApi: () => ({}) as ApiClient,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sick = (kind: 'ich' | 'fin-rot') => ({
  kind,
  since: '2026-02-01T00:00:00.000Z',
  severity: 0.4,
  treatedUntil: null,
});

const course = (kind: Medicine['kind'], doses: number): Medicine => ({
  kind,
  potency: 'standard',
  doses,
  until: new Date(Date.now() + 48 * 3_600_000).toISOString(),
});

describe('switching medicine', () => {
  let container: HTMLElement;
  let root: Root;
  const errors: unknown[][] = [];
  const treat = vi.fn(async () => ({ ok: true, refusal: null, reason: null }));

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    errors.length = 0;
    treat.mockClear();
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('button not found');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const button = (text: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

  async function mount(medicine: Medicine) {
    const tank = tankFixture({
      fish: [
        fishFixture(FISH_1, { name: 'Pip', disease: sick('ich') }),
        fishFixture(FISH_2, { name: 'Dot', disease: sick('fin-rot') }),
      ],
      medicine,
    });
    const session = { treat } as unknown as TankSession;
    await act(async () => {
      root.render(
        <Treatment
          session={session}
          state={{ ...INITIAL_STATE, species: [speciesFixture()] }}
          tank={tank}
        />,
      );
    });
  }

  const finRotDose = (): Element | null | undefined =>
    container.querySelector('article[aria-label^="Fin rot"]')?.querySelector('button.primary');

  it('warns before treat is called and only doses after the player confirms', async () => {
    await mount(course('ich', 0));
    await click(finRotDose());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Pip still has ich');
    expect(dialog?.textContent).toContain('ends what is left of the ich course');
    expect(treat).not.toHaveBeenCalled();

    await click(button('Dose anyway'));
    expect(treat).toHaveBeenCalledTimes(1);
    expect(treat).toHaveBeenCalledWith('fin-rot', 'standard');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('keeps the old course when the player backs out', async () => {
    await mount(course('ich', 0));
    await click(finRotDose());
    await click(button('Keep things as they are'));
    expect(treat).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('doses the same medicine again without a switch warning', async () => {
    await mount(course('ich', 0));
    await click(
      container.querySelector('article[aria-label^="Ich"]')?.querySelector('button.primary') ??
        undefined,
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(treat).toHaveBeenCalledWith('ich', 'standard');
  });
});
