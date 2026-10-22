// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { SessionProvider } from './session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function bridge(): UiBridge {
  return {
    engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
    interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe('decorate mode in the app shell', () => {
  let container: HTMLElement;
  let root: Root;
  let ui: UiBridge;
  const errors: unknown[][] = [];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    ui = bridge();
    errors.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(null), { status: 401 })),
    );
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const decorate = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Decorate'));

  it('keeps the menus and shows the decorate panel with a way out', async () => {
    const requests: { active: boolean }[] = [];
    ui.interaction.on('decor:request-mode', (r) => requests.push(r));
    const button = decorate();
    expect(button).toBeDefined();
    await act(async () => button?.click());
    await settle();

    expect(container.querySelector('.hud')).not.toBeNull();
    expect(container.querySelector('.dock')).not.toBeNull();
    const sheet = container.querySelector('.sheet-decor');
    expect(sheet).not.toBeNull();
    const done = [...(sheet?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Done',
    );
    expect(done).toBeDefined();
    expect(requests).toEqual([{ active: true }]);
    expect(errors).toEqual([]);

    await act(async () => done?.click());
    await settle();
    expect(container.querySelector('.sheet-decor')).toBeNull();
    expect(requests).toEqual([{ active: true }, { active: false }]);
  });

  it('leaves decorate mode on Escape', async () => {
    await act(async () => decorate()?.click());
    await settle();
    expect(container.querySelector('.sheet-decor')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('.sheet-decor')).toBeNull();
  });

  it('survives the engine reporting decorate active with pieces and a background', async () => {
    await act(async () => decorate()?.click());
    await act(async () => {
      ui.interaction.emit('background:state', {
        tankId: null,
        biome: 'freshwater',
        backgroundId: 'bg-fw-planted-stream',
      });
      ui.interaction.emit('decor:state', {
        active: true,
        persisted: false,
        pieces: [
          { id: 'a', label: 'Rock 1' },
          { id: 'b', label: 'Rock 2' },
        ],
        palette: [
          { assetId: 'vacation-feeder', label: 'Vacation feeder', kind: 'feeder' },
          { assetId: 'rock-a', label: 'Rock a', kind: 'rock' },
        ],
        selectedId: 'a',
        problem: null,
        hasFeeder: true,
      });
    });
    await settle();
    expect(container.querySelector('.hud')).not.toBeNull();
    expect(container.querySelector('.dock')).not.toBeNull();
    const text = container.querySelector('.sheet-decor')?.textContent ?? '';
    expect(text).toContain('Add a piece');
    expect(text).toContain('Background');
    expect(errors).toEqual([]);
  });
});
