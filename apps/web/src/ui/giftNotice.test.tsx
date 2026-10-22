// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import type { TankSession } from '../sync/session';
import { UiProviders } from './context';
import { FISH_1, TANK_A, fishFixture, tankFixture } from '../sync/fixtures';
import { GiftFishButton, GiftNotice } from './Gifts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GiftNotice', () => {
  let container: HTMLElement;
  let root: Root;
  const errors: unknown[][] = [];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    errors.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(null), { status: 401 })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mounts as an empty live region before anything is sent', async () => {
    const bridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    await act(async () => {
      root.render(
        <UiProviders bridge={bridge}>
          <GiftNotice session={{} as TankSession} />
        </UiProviders>,
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(errors).toEqual([]);
  });

  describe('with a real send', () => {
    const fish = fishFixture(FISH_1, { name: 'Pip' });
    const tank = tankFixture({ id: TANK_A, fish: [fish] });
    const offer = {
      id: '20000000-0000-4000-8000-000000000001',
      status: 'open',
      role: 'sender',
      counterpart: 'reef_fan',
      fish: {
        id: FISH_1,
        species: fish.species,
        name: 'Pip',
        sex: fish.sex,
        stage: fish.stage,
        size: fish.size,
        health: 1,
        disease: null,
      },
      wantsReturn: false,
      pledged: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      settledAt: null,
    };
    const bridge = () => ({
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    });
    const session = { applyGiftTank: vi.fn() } as unknown as TankSession;

    beforeEach(() => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          if (url.includes('/api/gifts') && init?.method === 'POST')
            return json({ offer, tank }, 201);
          if (url.includes('/api/gifts')) return json({ incoming: [], outgoing: [] });
          return json(null, 401);
        }),
      );
    });

    const send = async () => {
      const toggle = [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.startsWith('Gift or trade'),
      );
      await act(async () => toggle?.click());
      const input = container.querySelector<HTMLInputElement>('input[maxlength="21"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          'reef_fan',
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const form = container.querySelector('form');
      await act(async () => {
        form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    };

    const care = () => (
      <UiProviders bridge={bridgeValue}>
        <GiftFishButton session={session} tank={tank} fish={fish} />
        <GiftNotice session={session} />
      </UiProviders>
    );
    const bridgeValue = bridge();

    it('shows the notice in the Care panel after a successful send', async () => {
      await act(async () => root.render(care()));
      await send();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(
        'Pip is on its way to @reef_fan. You can cancel until they answer.',
      );
      expect(errors).toEqual([]);
    });

    it('does not carry the notice over when the panel is left and reopened', async () => {
      await act(async () => root.render(care()));
      await send();
      expect(container.querySelector('[role="status"]')?.textContent).toContain('reef_fan');

      await act(async () => root.render(<div />));
      await act(async () => root.render(care()));
      expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    });
  });
});
