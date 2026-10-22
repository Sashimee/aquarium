// @vitest-environment happy-dom
import { act, StrictMode, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { App } from './App';
import { UiProviders, type UiBridge } from './context';
import { SessionProvider } from './session';
import TrimDialog from './TrimDialog';

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

describe('always-mounted UI without a tank session', () => {
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

  it('mounts the trim dialog with no session and renders nothing', async () => {
    await act(async () => {
      root.render(
        <UiProviders bridge={bridge()}>
          <Suspense fallback={null}>
            <TrimDialog />
          </Suspense>
        </UiProviders>,
      );
    });
    await settle();
    expect(container.innerHTML).toBe('');
    expect(errors).toEqual([]);
  });

  it('mounts the app shell for a signed-out visitor without throwing', async () => {
    const ui = bridge();
    const noTank = vi.fn();
    ui.interaction.on('tank:none', noTank);
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
    const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(requested.some((url) => url.endsWith('/api/me'))).toBe(true);
    expect(noTank).toHaveBeenCalled();
    expect(container.querySelector('.shell')).not.toBeNull();
    expect(errors).toEqual([]);
  });
});
