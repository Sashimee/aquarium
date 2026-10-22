// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { SessionProvider } from './session';

vi.mock('./DecorPanel', () => ({
  get default(): never {
    throw new Error('Failed to fetch dynamically imported module');
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe('a decorate panel that fails to load', () => {
  let container: HTMLElement;
  let root: Root;
  const errors: unknown[][] = [];

  const reload = vi.fn();

  beforeEach(() => {
    reload.mockClear();
    sessionStorage.clear();
    vi.spyOn(window.location, 'reload').mockImplementation(reload);
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

  async function openDecorate() {
    const ui: UiBridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    await act(async () => {
      root.render(
        <StrictMode>
          <UiProviders bridge={ui}>
            <SessionProvider>
              <App />
            </SessionProvider>
          </UiProviders>
        </StrictMode>,
      );
    });
    await settle();
    const decorate = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Decorate'),
    );
    await act(async () => decorate?.click());
    await settle();
  }

  it('reloads once for the new build and keeps the menus meanwhile', async () => {
    await openDecorate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.hud')).not.toBeNull();
    expect(container.querySelector('.sheet-decor')?.textContent).toContain('Reloading');
  });

  it('keeps the menus, says what went wrong and offers a way out after a recent reload', async () => {
    sessionStorage.setItem('aquarium:stale-chunk-reload', String(Date.now()));
    await openDecorate();
    expect(reload).not.toHaveBeenCalled();

    expect(container.querySelector('.hud')).not.toBeNull();
    expect(container.querySelector('.dock')).not.toBeNull();
    const sheet = container.querySelector('.sheet-decor');
    expect(sheet?.querySelector('[role="alert"]')?.textContent).toContain('Reload');
    const done = [...(sheet?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Done',
    );
    expect(done).toBeDefined();
    expect(errors.some((args) => String(args[0]).includes('Decorate panel failed to render'))).toBe(
      true,
    );

    await act(async () => done?.click());
    expect(container.querySelector('.sheet-decor')).toBeNull();
    expect(container.querySelector('.hud')).not.toBeNull();
  });
});
