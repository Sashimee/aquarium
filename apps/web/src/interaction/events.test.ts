import { describe, expect, it } from 'vitest';
import { EventBus } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './events';

describe('sticky interaction events', () => {
  it('replays the Decorate state to a panel that loads after Decorate was pressed', () => {
    const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    const state = {
      active: true,
      persisted: false,
      palette: [],
      pieces: [],
      selectedId: null,
      hasFeeder: false,
      problem: null,
    };
    bus.emit('decor:state', state);
    expect(bus.peek('decor:state')).toBe(state);
  });

  it('keeps the camera mode, play tool and readiness for late subscribers', () => {
    const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    bus.emit('camera:mode-changed', { mode: 'dive' });
    bus.emit('play:tool-changed', { tool: 'laser' });
    bus.emit('play:ready', {});
    expect(bus.peek('camera:mode-changed')).toEqual({ mode: 'dive' });
    expect(bus.peek('play:tool-changed')).toEqual({ tool: 'laser' });
    expect(bus.peek('play:ready')).toEqual({});
  });
});
