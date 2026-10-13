import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { UiProviders, useCameraMode, useEngineReady, useLatest } from './context';

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

  it('useLatest returns undefined for an event that never fired', () => {
    const b = bridge();
    const html = render(b, () => String(useLatest(b.interaction, 'play:ready') === undefined));
    expect(html).toContain('true');
  });
});
