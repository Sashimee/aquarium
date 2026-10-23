import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../engine/events';
import { STICKY_INTERACTION_EVENTS, type InteractionEvents } from './events';
import { bindRoomAmbience } from './roomAmbience';

function setup() {
  const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
  const sink = { setAmbience: vi.fn() };
  const stop = bindRoomAmbience(bus, sink);
  return { bus, sink, stop };
}

describe('bindRoomAmbience', () => {
  it('asks for the loop of the room already shown', () => {
    const bus = new EventBus<InteractionEvents>(undefined, STICKY_INTERACTION_EVENTS);
    bus.emit('room:state', { tankId: null, roomId: 'room-bedroom' });
    const sink = { setAmbience: vi.fn() };
    bindRoomAmbience(bus, sink);
    expect(sink.setAmbience).toHaveBeenCalledWith('freesound-630612');
  });

  it('switches the loop with the room and stops it for none', () => {
    const { bus, sink } = setup();
    bus.emit('room:state', { tankId: 'a', roomId: 'room-office' });
    expect(sink.setAmbience).toHaveBeenLastCalledWith('freesound-327497');
    bus.emit('room:state', { tankId: 'a', roomId: null });
    expect(sink.setAmbience).toHaveBeenLastCalledWith(null);
  });

  it('stops listening once unbound', () => {
    const { bus, sink, stop } = setup();
    stop();
    sink.setAmbience.mockClear();
    bus.emit('room:state', { tankId: 'a', roomId: 'room-zen' });
    expect(sink.setAmbience).not.toHaveBeenCalled();
  });
});
