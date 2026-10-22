import { BACKGROUND_IDS, type Biome } from '@aquarium/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { backgroundOptions } from './backgroundTitles';
import { UiProviders } from './context';
import { BackgroundChooser } from './DecorPanel';

function render(state?: InteractionEvents['background:state']): string {
  const bridge = {
    engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
    interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
  };
  if (state) bridge.interaction.emit('background:state', state);
  return renderToStaticMarkup(
    createElement(UiProviders, { bridge, children: createElement(BackgroundChooser) }),
  ).replace(/<!-- -->/g, '');
}

describe('backgroundOptions', () => {
  it('lists the biome set in contract order with the content titles', () => {
    const options = backgroundOptions('reef');
    expect(options.map((o) => o.id)).toEqual([...BACKGROUND_IDS.reef]);
    expect(options[0]?.title).toBe('Coral wall');
  });

  it('titles every blackwater and mangrove background', () => {
    expect(backgroundOptions('blackwater').map((o) => o.id)).toEqual([
      ...BACKGROUND_IDS.blackwater,
    ]);
    expect(backgroundOptions('mangrove').map((o) => o.id)).toEqual([...BACKGROUND_IDS.mangrove]);
  });

  it('is empty for a biome without backgrounds', () => {
    expect(backgroundOptions('atlantis' as Biome)).toEqual([]);
  });
});

describe('BackgroundChooser', () => {
  it('renders nothing before any background is on show', () => {
    expect(render()).toBe('');
  });

  it('renders nothing for a biome without backgrounds', () => {
    expect(render({ tankId: null, biome: 'atlantis' as Biome, backgroundId: null })).toBe('');
  });

  it('offers every background as a button and marks the shown one pressed', () => {
    const html = render({
      tankId: 't',
      biome: 'freshwater',
      backgroundId: BACKGROUND_IDS.freshwater[1],
    });
    expect(html.match(/<button/g)).toHaveLength(BACKGROUND_IDS.freshwater.length);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]+</);
  });
});
