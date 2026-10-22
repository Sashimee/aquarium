import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventBus, type EngineEvents } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from '../interaction/events';
import { UiProviders } from './context';
import TrimDialog from './TrimDialog';

describe('TrimDialog without a session', () => {
  it('renders nothing for signed-out, demo and still-loading visitors', () => {
    const bridge = {
      engine: new EventBus<EngineEvents>(undefined, ['engine:ready']),
      interaction: new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS),
    };
    const html = renderToStaticMarkup(
      createElement(UiProviders, { bridge, children: createElement(TrimDialog) }),
    );
    expect(html).toBe('');
  });
});
