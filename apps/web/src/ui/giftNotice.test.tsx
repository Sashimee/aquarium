// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import type { TankSession } from '../sync/session';
import { UiProviders } from './context';
import { GiftNotice } from './Gifts';

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
});
