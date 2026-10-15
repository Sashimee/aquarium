import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { createApiClient } from './api';
import {
  UiProviders,
  useAuth,
  useCameraMode,
  useDecorLoadError,
  useDecorSaveState,
  useDecorState,
  useEngineReady,
  useLatest,
  type AuthState,
} from './context';

function bridge() {
  return {
    engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
    interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
  };
}

function render(b: ReturnType<typeof bridge>, Probe: () => string) {
  return renderToStaticMarkup(
    createElement(UiProviders, {
      bridge: b,
      children: createElement('p', null, createElement(Probe)),
    }),
  );
}

describe('late-mounting UI hooks', () => {
  it('shows the engine as ready when engine:ready fired before React mounted', () => {
    const b = bridge();
    b.engine.emit('engine:ready', { backend: 'webgl2', tier: 'low', gpuTiming: false });
    const html = render(b, () => (useEngineReady() ? 'ready' : 'loading'));
    expect(html).toContain('ready');
  });

  it('shows loading when the engine has not signalled yet', () => {
    const html = render(bridge(), () => (useEngineReady() ? 'ready' : 'loading'));
    expect(html).toContain('loading');
  });

  it('starts from the camera mode announced before mount', () => {
    const b = bridge();
    b.interaction.emit('camera:mode-changed', { mode: 'dive' });
    expect(render(b, () => useCameraMode())).toContain('dive');
  });

  it('starts the decor panel from the state published before its chunk loaded', () => {
    const b = bridge();
    b.interaction.emit('decor:state', {
      active: true,
      persisted: true,
      palette: [],
      pieces: [],
      selectedId: 'p3',
      hasFeeder: false,
      problem: null,
    });
    b.interaction.emit('decor:state', {
      active: true,
      persisted: true,
      palette: [],
      pieces: [],
      selectedId: 'p4',
      hasFeeder: false,
      problem: null,
    });
    expect(render(b, () => useDecorState()?.selectedId ?? 'none')).toContain('p4');
  });

  it('has no decor state, save state or error before the editor publishes any', () => {
    const b = bridge();
    expect(render(b, () => String(useDecorState()))).toContain('null');
    expect(render(b, () => useDecorSaveState().status)).toContain('idle');
    expect(render(b, () => String(useDecorLoadError()))).toContain('null');
  });

  it('shows a decor load failure and save status that arrived before mount', () => {
    const b = bridge();
    b.interaction.emit('decor:load-failed', { message: 'chunk failed' });
    b.interaction.emit('decor:save-state', { status: 'error', message: 'offline' });
    expect(render(b, () => String(useDecorLoadError()))).toContain('chunk failed');
    expect(render(b, () => useDecorSaveState().status)).toContain('error');
  });

  it('useLatest returns undefined for an event that never fired', () => {
    const b = bridge();
    const html = render(b, () => String(useLatest(b.interaction, 'play:ready') === undefined));
    expect(html).toContain('true');
  });
});

describe('sign-out', () => {
  function captureAuth(signOut: () => Promise<void>): AuthState {
    let captured: AuthState | undefined;
    const api = { ...createApiClient(), signOut };
    renderToStaticMarkup(
      createElement(UiProviders, {
        bridge: bridge(),
        api,
        children: createElement(() => {
          captured = useAuth();
          return null;
        }),
      }),
    );
    if (!captured) throw new Error('the probe did not render');
    return captured;
  }

  it('asks the server to end the session', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    await captureAuth(signOut).signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('reports a failed sign-out instead of pretending the session ended', async () => {
    const failure = new Error('offline');
    await expect(captureAuth(vi.fn().mockRejectedValue(failure)).signOut()).rejects.toBe(failure);
  });
});
