// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import type { PlantPick } from '../scene/plantGrowth';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { panelLoaders } from './panelLoaders';
import { SessionProvider } from './session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe('a trim tool chunk that fails to load', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    sessionStorage.setItem('aquarium:stale-chunk-reload', String(Date.now() - 1_000));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    vi.spyOn(panelLoaders, 'trim').mockRejectedValue(
      new Error('Failed to fetch dynamically imported module: /assets/TrimDialog-old.js'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(null), { status: 401 })),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows Reload and Dismiss clear of the dock, and the dock keeps working', async () => {
    const ui: UiBridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    await act(async () => {
      root.render(
        <UiProviders bridge={ui}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </UiProviders>,
      );
    });
    await settle();

    expect(window.location.reload).not.toHaveBeenCalled();
    const notice = container.querySelector('.crash-app');
    expect(notice?.textContent).toContain('trim tool');
    const labels = [...(notice?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(['Reload', 'Dismiss']);
    expect(container.querySelector('.dock')).not.toBeNull();

    const decorate = [...container.querySelectorAll('.dock button')].find((b) =>
      b.textContent?.includes('Decorate'),
    );
    await act(async () => (decorate as HTMLElement | undefined)?.click());
    await settle();
    expect(container.querySelector('.sheet-decor')).not.toBeNull();

    const dismiss = [...(notice?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Dismiss',
    );
    await act(async () => dismiss?.click());
    expect(container.querySelector('.crash-app')).toBeNull();
    expect(container.querySelector('.sheet-decor')).not.toBeNull();
  });

  it('says so on the next plant tap after the notice was dismissed', async () => {
    const ui: UiBridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    await act(async () => {
      root.render(
        <UiProviders bridge={ui}>
          <SessionProvider>
            <App />
          </SessionProvider>
        </UiProviders>,
      );
    });
    await settle();
    const dismiss = [...container.querySelectorAll('.crash-app button')].find(
      (b) => b.textContent === 'Dismiss',
    );
    await act(async () => (dismiss as HTMLElement | undefined)?.click());
    expect(container.querySelector('.crash-app')).toBeNull();
    expect(container.textContent).not.toContain('trim tool did not load');

    await act(async () => ui.interaction.emit('plant:picked', { pick: null }));
    expect(container.textContent).not.toContain('trim tool did not load');

    await act(async () =>
      ui.interaction.emit('plant:picked', { pick: { key: 's1' } as PlantPick }),
    );
    expect(container.querySelector('p.hint[role="status"]')?.textContent).toContain(
      'trim tool did not load',
    );
  });
});
